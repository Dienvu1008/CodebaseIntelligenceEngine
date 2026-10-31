/**
 * Builds a revision's code graph from its manifest (Phase 02, P02-08): extract every file an extractor
 * claims, run every resolver once, then project nodes and edges (code-intelligence projectCodeGraph).
 *
 *  - Bytes are re-read through the FileSystem port and must hash to the manifest entry; a file that changed
 *    since enumeration is skipped with CHANGED_DURING_INDEX instead of being extracted from content that
 *    does not match its contentHash (SY-003). The next run picks it up.
 *  - A file the extractor cannot process (undecodable, unreadable) is skipped and reported; the revision
 *    still publishes everything else. Cancellation aborts the whole run.
 *  - Resolvers run in precedence order: highest `imports` fidelity first, then adapter id. For the same
 *    (type, from, site, bound name), the first resolver's edge wins and later ones are superseded
 *    (CODE_INTELLIGENCE_STRATEGY §4). A failing resolver is reported and skipped.
 */
import type { CodeGraph, Fidelity, FileExtraction, LanguageRegistry, ProjectResolver, StructuralEdge } from '../../code-intelligence/public.js';
import { atLeast, projectCodeGraph } from '../../code-intelligence/public.js';
import type { CancellationSignal, CanonicalPath, DomainError, Hasher, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import type { FileSystem, ManifestEntry } from '../../workspace/public.js';

export interface CodeIntelligenceDeps {
  readonly registry: LanguageRegistry;
  /** Root-confined file access, for re-reading file bytes and for resolver configuration files. */
  readonly fs: FileSystem;
}

export interface CodeDiagnostic {
  readonly code: string;
  readonly path: CanonicalPath | null;
  readonly message: string;
}

export interface CodeStats {
  readonly extractedFiles: number;
  readonly symbols: number;
  readonly nodes: number;
  readonly edges: number;
  /** Files the extractor claims but could not process, in path order. */
  readonly skipped: readonly { readonly path: CanonicalPath; readonly code: string }[];
  /** Parse errors, resolver and projection diagnostics (counted; details are logged by callers). */
  readonly diagnostics: number;
}

export interface BuiltCodeGraph {
  readonly graph: CodeGraph;
  readonly stats: CodeStats;
  readonly diagnostics: readonly CodeDiagnostic[];
}

const EMPTY: BuiltCodeGraph = {
  graph: { nodes: [], edges: [], files: [], diagnostics: [] },
  stats: { extractedFiles: 0, symbols: 0, nodes: 0, edges: 0, skipped: [], diagnostics: 0 },
  diagnostics: [],
};

const cancelled = (): Result<never, DomainError> => err(domainError('INDEX_CANCELLED', 'indexing was cancelled'));

interface Extracted {
  readonly extractions: FileExtraction[];
  readonly skipped: { path: CanonicalPath; code: string }[];
  readonly diagnostics: CodeDiagnostic[];
}

type IndexedEntry = Extract<ManifestEntry, { status: 'indexed' }>;

async function extractOne(code: CodeIntelligenceDeps, hasher: Hasher, e: IndexedEntry, signal: CancellationSignal): Promise<Result<FileExtraction, string>> {
  const language = code.registry.languageForPath(e.path);
  const extractor = language === null ? null : code.registry.extractorFor(language);
  if (language === null || extractor === null) return err('NO_EXTRACTOR');
  const bytes = await code.fs.readFile(e.path, signal);
  if (!bytes.ok) return err('UNREADABLE');
  if (hasher.sha256(bytes.value) !== e.hash) return err('CHANGED_DURING_INDEX');
  const r = await extractor.extractFile({ path: e.path, language, content: bytes.value, contentHash: e.hash }, signal);
  return r.ok ? r : err(r.error.code);
}

async function extractAll(code: CodeIntelligenceDeps, hasher: Hasher, entries: readonly ManifestEntry[], signal: CancellationSignal): Promise<Result<Extracted, DomainError>> {
  const out: Extracted = { extractions: [], skipped: [], diagnostics: [] };
  for (const e of entries) {
    if (e.status !== 'indexed') continue;
    if (signal.aborted) return cancelled();
    const r = await extractOne(code, hasher, e, signal);
    if (r.ok) {
      out.extractions.push(r.value);
      for (const d of r.value.diagnostics) out.diagnostics.push({ code: d.code, path: e.path, message: d.message });
    } else if (r.error === 'EXTRACTION_CANCELLED' || signal.aborted) {
      return cancelled();
    } else if (r.error !== 'NO_EXTRACTOR') {
      out.skipped.push({ path: e.path, code: r.error });
    }
  }
  return ok(out);
}

/** Every registered resolver once, in precedence order (highest imports fidelity, then adapter id). */
function resolversInOrder(registry: LanguageRegistry): ProjectResolver[] {
  const unique = new Map<string, ProjectResolver>();
  for (const def of registry.languages()) for (const r of registry.resolversFor(def.id)) unique.set(r.producer.adapterId, r);
  const best = (r: ProjectResolver): Fidelity => r.profiles.reduce<Fidelity>((m, p) => (atLeast(p.fidelity.imports, m) ? p.fidelity.imports : m), 'L0');
  return [...unique.values()].sort((a, b) => {
    const fa = best(a);
    const fb = best(b);
    if (fa !== fb) return atLeast(fa, fb) ? -1 : 1;
    return a.producer.adapterId < b.producer.adapterId ? -1 : a.producer.adapterId > b.producer.adapterId ? 1 : 0;
  });
}

const siteKey = (e: StructuralEdge): string => {
  const r = e.evidence.range;
  return `${e.type}\u0000${e.from}\u0000${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}\u0000${e.attrs.name ?? ''}`;
};

async function resolveAll(
  code: CodeIntelligenceDeps,
  entries: readonly ManifestEntry[],
  extractions: readonly FileExtraction[],
  diagnostics: CodeDiagnostic[],
  signal: CancellationSignal,
): Promise<Result<StructuralEdge[], DomainError>> {
  const edges: StructuralEdge[] = [];
  const claimed = new Set<string>();
  for (const resolver of resolversInOrder(code.registry)) {
    if (signal.aborted) return cancelled();
    const r = await resolver.resolve({ manifest: entries, extractions, fs: code.fs }, signal);
    if (!r.ok) {
      if (signal.aborted) return cancelled();
      diagnostics.push({ code: r.error.code, path: null, message: `resolver ${resolver.producer.adapterId} failed: ${r.error.message}` });
      continue;
    }
    for (const d of r.value.diagnostics) diagnostics.push({ code: d.code, path: d.path, message: d.message });
    // Supersession is between resolvers only: one resolver may emit several edges for the same site (Python
    // `from pkg import a, b` gives the package plus two submodules), and all of them are kept.
    const sites = new Set<string>();
    for (const e of r.value.edges) {
      const key = siteKey(e);
      if (claimed.has(key)) continue; // superseded by a higher-precedence resolver
      sites.add(key);
      edges.push(e);
    }
    for (const key of sites) claimed.add(key);
  }
  return ok(edges);
}

export async function buildCodeGraph(
  code: CodeIntelligenceDeps | undefined,
  hasher: Hasher,
  entries: readonly ManifestEntry[],
  signal: CancellationSignal,
  onPhase: (phase: 'extracted' | 'resolved') => Promise<void>,
): Promise<Result<BuiltCodeGraph, DomainError>> {
  if (code === undefined) return ok(EMPTY);
  const extracted = await extractAll(code, hasher, entries, signal);
  if (!extracted.ok) return extracted;
  await onPhase('extracted');
  const { extractions, skipped, diagnostics } = extracted.value;
  const edges = await resolveAll(code, entries, extractions, diagnostics, signal);
  if (!edges.ok) return edges;
  await onPhase('resolved');
  const indexed = new Set(entries.filter((e) => e.status === 'indexed').map((e) => e.path));
  const graph = projectCodeGraph(extractions, edges.value, indexed);
  for (const d of graph.diagnostics) diagnostics.push(d);
  const symbols = extractions.reduce((n, x) => n + x.symbols.length, 0);
  return ok({
    graph,
    stats: { extractedFiles: extractions.length, symbols, nodes: graph.nodes.length, edges: graph.edges.length, skipped, diagnostics: diagnostics.length },
    diagnostics,
  });
}
