/**
 * Provenance vocabulary of the knowledge context (DOMAIN_MODEL §4, KNOWLEDGE_GRAPH_DESIGN §4–§5):
 * claim statuses, actors, origins and explicit evidence.
 *
 *  - Evidence is built only through `createEvidence`, which enforces PV-003 (kind, producer, seq, content
 *    hash and a locator: a workspace path with an optional range, or an artifact reference). Its id is
 *    derived from its content, so the same observation always gets the same id.
 *  - `qualifyingEvidence` is the single definition of PV-001's "deterministic evidence that still matches
 *    the revision". ClaimVerifier and the RevisionValidator both use it.
 */
import type { CanonicalPath, ClaimId, ContentHash, DomainError, EvidenceId, Hasher, NodeId, Result, RevisionSeq, SourceRange } from '../../shared-kernel/index.js';
import { domainError, err, ok, sourceRange } from '../../shared-kernel/index.js';
import { formatProducer, type ProducerIdentity } from '../../code-intelligence/public.js';
import type { GraphNodeKind, RelationStatus } from './relation-type.js';

export type ClaimStatus = RelationStatus;
export type ClaimFreshness = 'current' | 'stale';

export type EvidenceKind = 'filesystem' | 'ast' | 'compiler' | 'scip' | 'lsp' | 'heuristic' | 'llm' | 'user';
export const EVIDENCE_KINDS: readonly EvidenceKind[] = ['filesystem', 'ast', 'compiler', 'scip', 'lsp', 'heuristic', 'llm', 'user'];
/** Kinds produced by deterministic tools; only these can support `verified` (PV-001). */
export const DETERMINISTIC_EVIDENCE_KINDS: readonly EvidenceKind[] = ['filesystem', 'ast', 'compiler', 'scip', 'lsp'];
export const isDeterministic = (kind: EvidenceKind): boolean => DETERMINISTIC_EVIDENCE_KINDS.includes(kind);

/** Where the evidence was observed: a workspace file (optionally a range in it) or an external artifact. */
export type EvidenceLocator =
  | { readonly kind: 'source'; readonly path: CanonicalPath; readonly range: SourceRange | null }
  | { readonly kind: 'artifact'; readonly artifact: string };

export interface Evidence {
  readonly id: EvidenceId;
  readonly kind: EvidenceKind;
  readonly producer: ProducerIdentity;
  /** Revision the observation was made at. */
  readonly seq: RevisionSeq;
  /** Hash of the observed content: the file version for a source locator, the artifact for an artifact. */
  readonly contentHash: ContentHash;
  readonly locator: EvidenceLocator;
}

export interface EvidenceInput {
  readonly kind: EvidenceKind;
  readonly producer: ProducerIdentity;
  readonly seq: RevisionSeq;
  readonly contentHash: ContentHash;
  readonly locator: EvidenceLocator;
}

/** `scheme:rest`, e.g. `scip:index.scip#12`, `llm:response:<hash>`, `page:<PageId>#frontmatter`. */
const ARTIFACT = /^[a-z][a-z0-9-]*:[^\s]+$/;

const fail = (code: string, message: string, details?: Readonly<Record<string, unknown>>): Result<never, DomainError> => err(domainError(code, message, details));

function checkLocator(kind: EvidenceKind, locator: EvidenceLocator): Result<true, DomainError> {
  if (locator.kind === 'artifact') {
    if (!ARTIFACT.test(locator.artifact)) return fail('PV_003_LOCATOR_INVALID', `artifact reference "${locator.artifact}" is not of the form scheme:reference`, { artifact: locator.artifact });
    if (kind === 'llm' && !locator.artifact.startsWith('llm:')) return fail('PV_003_LOCATOR_INVALID', 'llm evidence must reference its response artifact (llm:…)');
    return ok(true);
  }
  if (kind === 'llm') return fail('PV_003_LOCATOR_INVALID', 'llm evidence must reference its response artifact, not a source location (AI-001)');
  if (locator.path === '') return fail('PV_003_LOCATOR_INVALID', 'a source locator needs a path');
  if (locator.range !== null) {
    const r = locator.range;
    const v = sourceRange(r.startLine, r.startCol, r.endLine, r.endCol);
    if (!v.ok) return fail('PV_003_LOCATOR_INVALID', `invalid evidence range: ${v.error.message}`, { ...v.error.details });
  }
  return ok(true);
}

const locatorKey = (l: EvidenceLocator): string => {
  if (l.kind === 'artifact') return `artifact\u0000${l.artifact}`;
  const r = l.range;
  return `source\u0000${l.path}\u0000${r === null ? '' : `${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`}`;
};

const shortHash = (hasher: Hasher, text: string): string => hasher.sha256Text(text).slice('sha256:'.length, 'sha256:'.length + 32);

/** PV-003: an evidence item with every required field; `ev:<hash(kind, producer, locator, contentHash)>`. */
export function createEvidence(input: EvidenceInput, hasher: Hasher): Result<Evidence, DomainError> {
  if (!EVIDENCE_KINDS.includes(input.kind)) return fail('PV_003_KIND_INVALID', `unknown evidence kind "${String(input.kind)}"`);
  const p = input.producer;
  if (p.adapterId === '' || p.adapterVersion === '' || p.toolVersion === '') return fail('PV_003_PRODUCER_MISSING', 'evidence needs a producer id and version');
  const locator = checkLocator(input.kind, input.locator);
  if (!locator.ok) return locator;
  const key = [input.kind, formatProducer(p), locatorKey(input.locator), input.contentHash].join('\u0001');
  const locatorCopy: EvidenceLocator = input.locator.kind === 'artifact' ? { kind: 'artifact', artifact: input.locator.artifact } : { kind: 'source', path: input.locator.path, range: input.locator.range === null ? null : { ...input.locator.range } };
  return ok(
    Object.freeze({
      id: `ev:${shortHash(hasher, key)}` as EvidenceId,
      kind: input.kind,
      producer: { adapterId: p.adapterId, adapterVersion: p.adapterVersion, toolVersion: p.toolVersion },
      seq: input.seq,
      contentHash: input.contentHash,
      locator: locatorCopy,
    }),
  );
}

/** What PV-001 needs to know about the revision: its seq and the current hash of a locator's target. */
export interface RevisionView {
  readonly seq: RevisionSeq;
  /** Current content hash of the locator's target at `seq`, or null when it no longer exists. */
  currentHash(locator: EvidenceLocator): ContentHash | null;
}

/**
 * PV-001: the evidence items that can support `verified` at `view.seq`: deterministic kind, observed no
 * later than the revision, and still matching the current content of what they point at.
 */
export function qualifyingEvidence(evidence: readonly Evidence[], view: RevisionView): readonly Evidence[] {
  return evidence.filter((e) => isDeterministic(e.kind) && e.seq <= view.seq && view.currentHash(e.locator) === e.contentHash);
}

/** Who performs a claim transition (PV-002 records it). LLM actors can never change a status (AI-002). */
export interface ClaimActor {
  readonly kind: 'system' | 'producer' | 'user' | 'llm';
  readonly id: string;
}

/** Where a claim comes from (KNOWLEDGE_GRAPH_DESIGN §5 `claim.origin`). */
export interface ClaimOrigin {
  readonly kind: 'producer' | 'heuristic' | 'llm' | 'page';
  readonly id: string;
}

export const formatOrigin = (o: ClaimOrigin): string => `${o.kind}:${o.id}`;
export const formatActor = (a: ClaimActor): string => `${a.kind}:${a.id}`;

const TOKEN = /^[^\s\u0000-\u001f]+$/; // eslint-disable-line no-control-regex

export function checkActor(a: ClaimActor): Result<true, DomainError> {
  return TOKEN.test(a.id) ? ok(true) : fail('PV_002_ACTOR_INVALID', `actor id "${a.id}" is empty or not printable`);
}

export function checkOrigin(o: ClaimOrigin): Result<true, DomainError> {
  return TOKEN.test(o.id) ? ok(true) : fail('CLAIM_ORIGIN_INVALID', `origin id "${o.id}" is empty or not printable`);
}

/** A claim endpoint: a node id with its kind, so KG-002 can check the predicate's signature. */
export interface ClaimNode {
  readonly id: NodeId;
  readonly kind: GraphNodeKind;
}

/** `claim:<hash(subject, predicate, object, origin)>`: re-intake of the same claim never duplicates it. */
export function claimId(subject: ClaimNode, predicate: string, object: ClaimNode, origin: ClaimOrigin, hasher: Hasher): ClaimId {
  return `claim:${shortHash(hasher, [subject.id, predicate, object.id, formatOrigin(origin)].join('\u0001'))}` as ClaimId;
}
