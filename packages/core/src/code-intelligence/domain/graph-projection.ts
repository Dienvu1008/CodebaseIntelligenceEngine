/**
 * Graph projection (KNOWLEDGE_GRAPH_DESIGN §2–§3; KG-001, KG-003, SY-002, SY-005): turns file extractions and
 * resolver edges into the code nodes and edges one revision stores. Pure and deterministic: the same
 * inputs give the same nodes and edges, sorted by id / identity.
 *
 * Nodes:  module (one per extraction), symbol (one per extracted symbol), external and unresolved (one per
 *         distinct target of an import edge). A `mod:` target that has no extraction (for example a file
 *         whose extraction failed) gets a bare module node, backed by its file, if the file is in the
 *         manifest; otherwise the edge is dropped with a diagnostic, so no edge ever dangles (KG-001).
 * Edges:  contains (symbol → nested symbol), defines (module → top-level symbol), exports (module → exported
 *         top-level symbol), and the resolver's imports / imports_symbol edges.
 *         Intra-file syntactic edges (contains, defines, exports) carry no precision: they are not
 *         resolutions (SY-006 governs resolved edges). They are `verified`, except Python exports, which
 *         are a naming convention and therefore `inferred`.
 * Identity: an edge is identified by (type, from, to, site). The site is empty for every Phase 02 type
 *         (KNOWLEDGE_GRAPH_DESIGN §4). Several import statements with the same identity merge into one edge
 *         that keeps the evidence of the earliest statement.
 */
import type { CanonicalPath, ContentHash, NodeId, SourceRange } from '../../shared-kernel/index.js';
import type { LanguageId, Precision, ProducerRef } from './capability.js';
import type { ExtractedSymbol, FileExtraction } from './file-extraction.js';
import type { EdgeStatus, ImportEdgeType } from './import-edge.js';
import { moduleNodeId } from './import-edge.js';
import { isRelationEdge, RELATION_EDGE_TYPES, type RelationEdgeType, type ResolvedEdge } from './relation-edge.js';
import type { SymbolKind } from './symbol-identity.js';

export type CodeNodeKind = 'module' | 'symbol' | 'external' | 'unresolved';
export type CodeEdgeType = 'contains' | 'defines' | 'exports' | ImportEdgeType | RelationEdgeType;
export const CODE_NODE_KINDS: readonly CodeNodeKind[] = ['module', 'symbol', 'external', 'unresolved'];
export const CODE_EDGE_TYPES: readonly CodeEdgeType[] = ['contains', 'defines', 'exports', 'imports', 'imports_symbol', ...RELATION_EDGE_TYPES];
/** Edge types a resolver produces (SY-006 governs their precision); the others are syntactic. */
export const RESOLVED_EDGE_TYPES: readonly CodeEdgeType[] = ['imports', 'imports_symbol', ...RELATION_EDGE_TYPES];
/** Relation types merged per (from, to), counting their occurrences in `attrs.occurrences`. */
const AGGREGATED: readonly CodeEdgeType[] = ['references', 'references_type', 'extends', 'implements'];

export interface SymbolFacts {
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly range: SourceRange;
  readonly spanHash: ContentHash;
  readonly bodyFingerprint: ContentHash;
  readonly exported: boolean;
  readonly defaultExport: boolean;
  readonly doc: string | null;
}

export interface CodeNode {
  readonly id: NodeId;
  readonly kind: CodeNodeKind;
  /** Display name: the symbol name, the file name, the package name or the raw specifier. */
  readonly name: string;
  /** Backing file (KG-003): the module's file, the symbol's file, or the file holding an unresolved site. */
  readonly file: CanonicalPath | null;
  readonly language: LanguageId | null;
  readonly symbol: SymbolFacts | null;
  readonly producer: ProducerRef;
}

export interface EdgeEvidence {
  readonly kind: 'ast' | 'compiler' | 'heuristic';
  readonly path: CanonicalPath;
  readonly range: SourceRange;
  readonly contentHash: ContentHash;
}

export interface CodeEdge {
  readonly type: CodeEdgeType;
  readonly from: NodeId;
  readonly to: NodeId;
  /** Site key of occurrence types (`calls`); empty for every other type. */
  readonly site: string;
  readonly status: EdgeStatus;
  readonly precision: Precision | null;
  readonly producer: ProducerRef;
  readonly evidence: EdgeEvidence | null;
  readonly attrs: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ProjectionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly path: CanonicalPath | null;
}

/**
 * Per-file facts the store keeps with the file version, not with nodes: the line count lets the
 * RevisionValidator check SY-003 (a) for every symbol without the file content.
 */
export interface SourceFileFacts {
  readonly path: CanonicalPath;
  readonly contentHash: ContentHash;
  readonly lineCount: number;
}

export interface CodeGraph {
  readonly nodes: readonly CodeNode[];
  readonly edges: readonly CodeEdge[];
  /** One entry per extracted file, sorted by path. */
  readonly files: readonly SourceFileFacts[];
  readonly diagnostics: readonly ProjectionDiagnostic[];
}

const byString = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);
export const edgeIdentity = (e: Pick<CodeEdge, 'type' | 'from' | 'to' | 'site'>): string => `${e.type}\u0000${e.from}\u0000${e.to}\u0000${e.site}`;
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const rangeBefore = (a: SourceRange, b: SourceRange): boolean =>
  a.startLine !== b.startLine ? a.startLine < b.startLine : a.startCol !== b.startCol ? a.startCol < b.startCol : a.endLine !== b.endLine ? a.endLine < b.endLine : a.endCol < b.endCol;

function symbolNode(e: FileExtraction, s: ExtractedSymbol): CodeNode {
  const { qualifiedName, kind, range, spanHash, bodyFingerprint, exported, defaultExport, doc } = s;
  return {
    id: s.id as string as NodeId,
    kind: 'symbol',
    name: s.name,
    file: e.path,
    language: e.language,
    symbol: { qualifiedName, kind, range, spanHash, bodyFingerprint, exported, defaultExport, doc },
    producer: s.producer,
  };
}

function moduleNode(e: FileExtraction): CodeNode {
  const producer = { ...e.producer, fidelity: e.profile.fidelity.symbols };
  return { id: moduleNodeId(e.language, e.path), kind: 'module', name: baseName(e.path), file: e.path, language: e.language, symbol: null, producer };
}

function syntacticEdges(e: FileExtraction): CodeEdge[] {
  const mod = moduleNodeId(e.language, e.path);
  const out: CodeEdge[] = [];
  const edge = (type: CodeEdgeType, from: NodeId, s: ExtractedSymbol, status: EdgeStatus): CodeEdge => ({
    type,
    from,
    to: s.id as string as NodeId,
    site: '',
    status,
    precision: null,
    producer: s.producer,
    evidence: { kind: 'ast', path: e.path, range: s.range, contentHash: e.contentHash },
    attrs: {},
  });
  for (const s of e.symbols) {
    if (s.parent !== null) {
      out.push(edge('contains', s.parent as string as NodeId, s, 'verified'));
      continue;
    }
    out.push(edge('defines', mod, s, 'verified'));
    if (s.exported) out.push(edge('exports', mod, s, e.language === 'py' ? 'inferred' : 'verified'));
  }
  return out;
}

function placeholderNode(edge: ResolvedEdge): CodeNode | null {
  if (edge.toKind === 'external') {
    const name = edge.to.slice(edge.to.indexOf(':', 4) + 1);
    return { id: edge.to, kind: 'external', name, file: null, language: null, symbol: null, producer: edge.producer };
  }
  if (edge.toKind === 'unresolved') {
    return { id: edge.to, kind: 'unresolved', name: edge.attrs.raw, file: edge.evidence.path, language: null, symbol: null, producer: edge.producer };
  }
  return null;
}

function relationAttrs(type: RelationEdgeType, raw: string): CodeEdge['attrs'] {
  if (type === 'calls') return { raw };
  return { occurrences: 1 };
}

const toCodeEdge = (e: ResolvedEdge): CodeEdge => {
  const common = { type: e.type, from: e.from, to: e.to, status: e.status, precision: e.precision, producer: e.producer, evidence: e.evidence };
  if (isRelationEdge(e)) return { ...common, site: e.site, attrs: relationAttrs(e.type, e.attrs.raw) };
  return { ...common, site: '', attrs: { raw: e.attrs.raw, name: e.attrs.name, isDynamic: e.attrs.isDynamic, isTypeOnly: e.attrs.isTypeOnly } };
};

/**
 * First writer wins for nodes; for edges with the same identity, the earliest evidence wins. Aggregated
 * relation types also add up their occurrences.
 */
function mergeEdge(edges: Map<string, CodeEdge>, e: CodeEdge): void {
  const key = edgeIdentity(e);
  const old = edges.get(key);
  const earlier = old === undefined || (e.evidence !== null && old.evidence !== null && e.evidence.path === old.evidence.path && rangeBefore(e.evidence.range, old.evidence.range));
  if (old !== undefined && AGGREGATED.includes(e.type)) {
    const occurrences = Number(old.attrs['occurrences'] ?? 1) + Number(e.attrs['occurrences'] ?? 1);
    edges.set(key, { ...(earlier ? e : old), attrs: { occurrences } });
    return;
  }
  if (earlier) edges.set(key, e);
}

/**
 * Projects one revision's code graph. `resolved` must already be ordered by precedence (the
 * LanguageRegistry resolver order); `manifestFiles` are the indexed files of the revision.
 */
export function projectCodeGraph(extractions: readonly FileExtraction[], resolved: readonly ResolvedEdge[], manifestFiles: ReadonlySet<CanonicalPath>): CodeGraph {
  const nodes = new Map<string, CodeNode>();
  const edges = new Map<string, CodeEdge>();
  const diagnostics: ProjectionDiagnostic[] = [];
  for (const e of extractions) {
    nodes.set(moduleNodeId(e.language, e.path), moduleNode(e));
    for (const s of e.symbols) nodes.set(s.id, symbolNode(e, s));
    for (const edge of syntacticEdges(e)) mergeEdge(edges, edge);
  }
  for (const r of resolved) {
    if (!nodes.has(r.from)) {
      diagnostics.push({ code: 'EDGE_SOURCE_NOT_PROJECTED', message: `${r.type} edge from ${r.from} has no source module`, path: r.evidence.path });
      continue;
    }
    if (!nodes.has(r.to)) {
      const placeholder = placeholderNode(r);
      const target = r.to.startsWith('mod:') ? r.to.slice(r.to.indexOf(':', 4) + 1) : null;
      if (placeholder !== null) nodes.set(placeholder.id, placeholder);
      else if (target !== null && manifestFiles.has(target as CanonicalPath)) {
        const language = r.to.slice(4, r.to.indexOf(':', 4)) as LanguageId;
        nodes.set(r.to, { id: r.to, kind: 'module', name: baseName(target), file: target as CanonicalPath, language, symbol: null, producer: r.producer });
      } else {
        diagnostics.push({ code: 'EDGE_TARGET_NOT_PROJECTED', message: `${r.type} edge ${r.from} -> ${r.to} has no target node; dropped (KG-001)`, path: r.evidence.path });
        continue;
      }
    }
    mergeEdge(edges, toCodeEdge(r));
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => byString(a.id, b.id)),
    edges: [...edges.entries()].sort((a, b) => byString(a[0], b[0])).map(([, e]) => e),
    files: extractions.map((e) => ({ path: e.path, contentHash: e.contentHash, lineCount: e.lineCount })).sort((a, b) => byString(a.path, b.path)),
    diagnostics,
  };
}
