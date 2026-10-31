/**
 * IndexService: a full index of the workspace into one atomically published revision (FR-050, FR-055,
 * SN-001..SN-005, ADR-0015). Application layer: it orchestrates domain rules and ports, and does no I/O itself.
 *
 *   acquire lease → recover → begin(head) → enumerate → manifest → extract → resolve (code graph, Phase 02)
 *     → stage files + structure + code graph → validating → validate + span check (SY-003)
 *     → decidePublish (SN-001) → publish (CAS)
 *     → release
 *
 * Any failure after `begin` abandons the staging revision, so no partial revision is ever left behind by a
 * clean failure. Crashes are covered by recovery on the next run (SN-005). `onStage` is an observation hook
 * for progress reporting and crash-injection tests; it must not change behavior.
 */
import type { CancellationSignal, DomainError, Hasher, JobId, Result, RevisionSeq } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import type { EnumerationResult, ManifestEntry } from '../../workspace/public.js';
import { buildManifest, deriveStructure } from '../../workspace/public.js';
import { decidePublish } from '../domain/publish-policy.js';
import { jobTransition } from '../domain/lifecycle.js';
import { planRecovery, type RecoveryAction } from '../domain/recovery.js';
import type { ChangeSeq } from '../domain/types.js';
import { buildCodeGraph, type BuiltCodeGraph, type CodeDiagnostic, type CodeIntelligenceDeps, type CodeStats } from './code-graph-build.js';
import type { JobRecord, JobRepository, Lease, LeaseManager, RevisionStore, RevisionWriter, StageStats } from './ports.js';
import { DEFAULT_SPAN_SAMPLE, verifySpans } from './span-check.js';

/** Change-log position "no changes recorded yet". */
const NO_CHANGES = 0 as ChangeSeq;

export type IndexStage =
  | 'lease-acquired'
  | 'recovered'
  | 'revision-begun'
  | 'enumerated'
  | 'extracted'
  | 'resolved'
  | 'staged'
  | 'validating'
  | 'published';

export interface IndexServiceDeps {
  readonly store: RevisionStore & RevisionWriter;
  readonly lease: LeaseManager;
  readonly holder: string;
  readonly leaseTtlMs: number;
  readonly jobId: JobId;
  readonly hasher: Hasher;
  readonly enumerate: () => Promise<Result<EnumerationResult, DomainError>>;
  readonly signal: CancellationSignal;
  readonly onStage?: (stage: IndexStage) => void | Promise<void>;
  /** Optional job history (state.db). Interrupted jobs are marked failed during recovery. */
  readonly jobs?: JobRepository;
  /** Language adapters. Without them the revision gets an empty code graph (structure only). */
  readonly code?: CodeIntelligenceDeps;
  /**
   * Span hashes recomputed before publish (SY-003 b), DEFAULT_SPAN_SAMPLE when omitted; null rehashes every
   * symbol (tests). Bounds are always checked for every symbol.
   */
  readonly spanSample?: number | null;
}

export interface SpanStats {
  readonly total: number;
  readonly checked: number;
  readonly unverifiable: number;
}

export interface IndexOutcome {
  readonly seq: RevisionSeq;
  readonly manifestHash: string;
  readonly files: StageStats;
  readonly structure: StageStats;
  readonly graph: { readonly nodes: StageStats; readonly edges: StageStats };
  readonly code: CodeStats;
  readonly codeDiagnostics: readonly CodeDiagnostic[];
  readonly spans: SpanStats;
  readonly recovered: readonly RecoveryAction[];
  readonly enumeration: Pick<EnumerationResult, 'unrepresentable' | 'unlistable' | 'ignored'>;
}

async function recover(deps: IndexServiceDeps): Promise<Result<readonly RecoveryAction[], DomainError>> {
  const plan = planRecovery({ unfinished: await deps.store.listUnfinished(), leaseHeldByOther: await deps.lease.heldByOther(deps.holder) });
  for (const step of plan) {
    const r = await deps.store.abandon(step.seq, step.reason);
    if (!r.ok) return r;
  }
  // We hold the lease, so any job still marked active belongs to a writer that died (SN-005).
  for (const stale of (await deps.jobs?.listActive()) ?? []) {
    const failed = jobTransition(stale.state, 'failed');
    if (failed.ok) await deps.jobs?.save({ ...stale, state: failed.value });
  }
  return ok(plan);
}

async function recordJob(deps: IndexServiceDeps, state: JobRecord['state'], targetSeq: RevisionSeq | null): Promise<void> {
  await deps.jobs?.save({ id: deps.jobId, kind: 'full', state, targetSeq });
}

async function stage(deps: IndexServiceDeps): Promise<Result<RevisionSeq, DomainError>> {
  const head = await deps.store.head();
  const rev = await deps.store.begin(head?.seq ?? null, deps.jobId);
  if (!rev.ok) return rev;
  await deps.onStage?.('revision-begun');
  return ok(rev.value.seq);
}

async function buildAndPublish(
  deps: IndexServiceDeps,
  lease: Lease,
  seq: RevisionSeq,
  recovered: readonly RecoveryAction[],
): Promise<Result<IndexOutcome, DomainError>> {
  const enumeration = await deps.enumerate();
  if (!enumeration.ok) return enumeration;
  const manifest = buildManifest(enumeration.value.entries, deps.hasher);
  if (!manifest.ok) return manifest;
  await deps.onStage?.('enumerated');

  const code = await buildCodeGraph(deps.code, deps.hasher, manifest.value.entries, deps.signal, async (phase) => {
    await deps.onStage?.(phase);
  });
  if (!code.ok) return code;

  const staged = await stageEverything(deps, lease, seq, manifest.value.entries, code.value);
  if (!staged.ok) return staged;
  const published = await validateAndPublish(deps, seq);
  if (!published.ok) return published;

  const { unrepresentable, unlistable, ignored } = enumeration.value;
  return ok({
    seq,
    manifestHash: manifest.value.manifestHash,
    ...staged.value,
    code: code.value.stats,
    codeDiagnostics: code.value.diagnostics,
    spans: published.value,
    recovered,
    enumeration: { unrepresentable, unlistable, ignored },
  });
}

async function stageEverything(
  deps: IndexServiceDeps,
  lease: Lease,
  seq: RevisionSeq,
  entries: readonly ManifestEntry[],
  code: BuiltCodeGraph,
): Promise<Result<{ files: StageStats; structure: StageStats; graph: { nodes: StageStats; edges: StageStats } }, DomainError>> {
  // Enumeration and extraction can take long on big repositories: renew before writing (SN-004).
  const renewed = await deps.lease.renew(lease, deps.leaseTtlMs);
  if (!renewed.ok) return renewed;
  const files = await deps.store.stageManifest(seq, entries);
  if (!files.ok) return files;
  const structure = await deps.store.stageStructure(seq, deriveStructure(entries));
  if (!structure.ok) return structure;
  const graph = await deps.store.stageGraph(seq, code.graph);
  if (!graph.ok) return graph;
  await deps.onStage?.('staged');
  return ok({ files: files.value, structure: structure.value, graph: graph.value });
}

const NO_SPANS: SpanStats = { total: 0, checked: 0, unverifiable: 0 };

/** SY-003 (b) on the staged rows. Without language adapters the revision has no symbols to check. */
async function checkSpans(deps: IndexServiceDeps, seq: RevisionSeq): Promise<Result<{ stats: SpanStats; violations: readonly string[] }, DomainError>> {
  if (deps.code === undefined) return ok({ stats: NO_SPANS, violations: [] });
  const sample = deps.spanSample === undefined ? DEFAULT_SPAN_SAMPLE : deps.spanSample;
  const r = await verifySpans({ store: deps.store, fs: deps.code.fs, hasher: deps.hasher, signal: deps.signal }, seq, sample);
  if (!r.ok) return r;
  const { total, checked, unverifiable, violations } = r.value;
  return ok({ stats: { total, checked, unverifiable }, violations });
}

async function validateAndPublish(deps: IndexServiceDeps, seq: RevisionSeq): Promise<Result<SpanStats, DomainError>> {
  const validating = await deps.store.markValidating(seq);
  if (!validating.ok) return validating;
  await deps.onStage?.('validating');
  const spans = await checkSpans(deps, seq);
  if (!spans.ok) return spans;
  // An explicit full index processes every path directly, so it covers every change recorded so far. Until
  // the change log exists (Phase 05), both sides of the SN-001 check are the current head watermark.
  const head = await deps.store.head();
  const watermark = head?.watermark ?? NO_CHANGES;
  const candidate = await deps.store.get(seq);
  if (candidate === null) return err(domainError('REVISION_NOT_FOUND', 'staging revision disappeared', { seq }));
  const decision = decidePublish({
    candidate: { ...candidate, watermark },
    headSeq: head?.seq ?? null,
    sourceMaxChangeSeq: watermark,
    violations: [...(await deps.store.validate(seq)), ...spans.value.violations],
  });
  if (!decision.ok) return decision;
  const published = await deps.store.publish(seq, watermark);
  if (!published.ok) return published;
  await deps.onStage?.('published');
  return ok(spans.value.stats);
}

export async function runFullIndex(deps: IndexServiceDeps): Promise<Result<IndexOutcome, DomainError>> {
  const lease = await deps.lease.acquire(deps.holder, deps.leaseTtlMs);
  if (!lease.ok) return lease;
  try {
    await deps.onStage?.('lease-acquired');
    const recovered = await recover(deps);
    if (!recovered.ok) return recovered;
    await deps.onStage?.('recovered');
    await recordJob(deps, 'running', null);
    const seq = await stage(deps);
    if (!seq.ok) {
      await recordJob(deps, 'failed', null);
      return seq;
    }
    const outcome = await buildAndPublish(deps, lease.value, seq.value, recovered.value);
    if (!outcome.ok) await deps.store.abandon(seq.value, `failed: ${outcome.error.code}`);
    await recordJob(deps, outcome.ok ? 'succeeded' : 'failed', seq.value);
    return outcome;
  } finally {
    await deps.lease.release(lease.value);
  }
}
