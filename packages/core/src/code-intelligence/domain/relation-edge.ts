/**
 * Symbol-level relation edges built by resolvers (Phase 03, P03-07): `references`, `calls`, `extends`,
 * `implements` and `references_type` (KNOWLEDGE_GRAPH_DESIGN §3), with SY-006 applied at construction, as for
 * import edges:
 *  - the capability behind the type (`references`, `calls`, or `typeRelations` for the three type relations)
 *    must be at least L1; `exact` needs L3 and `heuristic` L2;
 *  - only `calls` may target an `unresolved` placeholder (a dynamic or unresolvable callee). Such an edge
 *    has no precision and status `unknown`; any concrete target would be a guess;
 *  - the source is an extracted symbol of the file, or the module itself for top-level code (`references`,
 *    `references_type`, `calls`). `extends` and `implements` always start at a symbol;
 *  - the edge cites its occurrence (file, range, content hash) as intrinsic evidence.
 *
 * Granularity (KNOWLEDGE_GRAPH_DESIGN §4): a `calls` edge is one call site, identified by a site key (hash of
 * the call range). The other types are one edge per (from, to): the projection merges their occurrences,
 * keeping the earliest as evidence and counting them in `attrs.occurrences`.
 */
import type { DomainError, Hasher, NodeId, Result, SourceRange, SymbolId } from '../../shared-kernel/index.js';
import { domainError, err, ok, sourceRange } from '../../shared-kernel/index.js';
import { atLeast, precisionAllowed, producerRef, type Capability, type Precision } from './capability.js';
import type { FileExtraction } from './file-extraction.js';
import type { EdgeStatus, ImportResolver, StructuralEdge } from './import-edge.js';
import { moduleNodeId } from './import-edge.js';

export type RelationEdgeType = 'references' | 'calls' | 'extends' | 'implements' | 'references_type';
export const RELATION_EDGE_TYPES: readonly RelationEdgeType[] = ['references', 'calls', 'extends', 'implements', 'references_type'];

/** The capability each relation type is produced under. */
export const RELATION_CAPABILITY: Readonly<Record<RelationEdgeType, Capability>> = {
  references: 'references',
  calls: 'calls',
  extends: 'typeRelations',
  implements: 'typeRelations',
  references_type: 'typeRelations',
};

/** Relation types identified per occurrence (non-empty site key). */
export const OCCURRENCE_EDGE_TYPES: readonly RelationEdgeType[] = ['calls'];

export interface RelationResolution {
  readonly type: RelationEdgeType;
  /** The extracted symbol of the file the occurrence lies in (innermost), or null for top-level code. */
  readonly from: SymbolId | null;
  readonly target: { readonly kind: 'symbol'; readonly id: SymbolId } | { readonly kind: 'unresolved' };
  /** The occurrence: the referencing name, the callee, or the base type expression. */
  readonly range: SourceRange;
  /** Source text of the occurrence (a callee such as `handlers[k]`), truncated by the factory. */
  readonly raw: string;
  readonly precision: Precision | null;
}

export interface RelationEdge {
  readonly type: RelationEdgeType;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly toKind: 'symbol' | 'unresolved';
  /** Site key for occurrence types (`calls`), empty otherwise. */
  readonly site: string;
  readonly status: EdgeStatus;
  readonly precision: Precision | null;
  readonly producer: StructuralEdge['producer'];
  readonly evidence: StructuralEdge['evidence'];
  readonly attrs: { readonly raw: string };
}

/** What a resolver returns: import edges and relation edges. */
export type ResolvedEdge = StructuralEdge | RelationEdge;

export const isRelationEdge = (e: ResolvedEdge): e is RelationEdge => (RELATION_EDGE_TYPES as readonly string[]).includes(e.type);

const MAX_RAW = 120;
const fail = (code: string, message: string, details?: Readonly<Record<string, unknown>>): Result<never, DomainError> => err(domainError(code, message, details));
const rangeKey = (r: SourceRange): string => `${r.startLine}:${r.startCol}-${r.endLine}:${r.endCol}`;
const siteHash = (hasher: Hasher, text: string): string => hasher.sha256Text(text).slice('sha256:'.length, 'sha256:'.length + 16);

function checkShape(extraction: FileExtraction, res: RelationResolution): Result<NodeId, DomainError> {
  const r = res.range;
  const v = sourceRange(r.startLine, r.startCol, r.endLine, r.endCol);
  if (!v.ok || r.endLine >= extraction.lineCount) return fail('EDGE_EVIDENCE_INVALID', `the ${res.type} occurrence ${rangeKey(r)} is not a range of ${extraction.path}`);
  if (res.from === null) {
    if (res.type === 'extends' || res.type === 'implements') return fail('EDGE_SIGNATURE_MISMATCH', `${res.type} starts at a class or interface symbol, not at a module`);
    return ok(moduleNodeId(extraction.language, extraction.path));
  }
  if (!extraction.symbols.some((s) => s.id === res.from)) return fail('EDGE_SIGNATURE_MISMATCH', `${res.from} is not a symbol of ${extraction.path}`);
  return ok(res.from as string as NodeId);
}

function checkPrecision(res: RelationResolution, resolver: ImportResolver): Result<Precision | null, DomainError> {
  const fidelity = resolver.profile.fidelity[RELATION_CAPABILITY[res.type]];
  if (res.target.kind === 'unresolved') {
    if (res.type !== 'calls') return fail('EDGE_SIGNATURE_MISMATCH', `only calls may target an unresolved site, not ${res.type}`);
    return res.precision === null ? ok(null) : fail('SY_006_PRECISION_ON_UNRESOLVED', 'an edge to an unresolved site carries no precision');
  }
  if (res.precision === null) return fail('EDGE_PRECISION_REQUIRED', 'a resolved edge must state its precision');
  if (!precisionAllowed(res.precision, fidelity)) {
    return fail('SY_006_PRECISION_OVERSTATED', `${res.precision} ${res.type} needs ${res.precision === 'exact' ? 'L3' : 'L2+'} ${RELATION_CAPABILITY[res.type]} fidelity; the resolver declares ${fidelity}`, {
      requested: res.precision,
      fidelity,
    });
  }
  return ok(res.precision);
}

export function createRelationEdge(extraction: FileExtraction, res: RelationResolution, resolver: ImportResolver, hasher: Hasher): Result<RelationEdge, DomainError> {
  if (resolver.profile.language !== extraction.language) {
    return fail('CAPABILITY_LANGUAGE_MISMATCH', `resolver profile is for "${resolver.profile.language}", the file is "${extraction.language}"`);
  }
  const capability = RELATION_CAPABILITY[res.type];
  if (!atLeast(resolver.profile.fidelity[capability], 'L1')) {
    return fail('SY_006_CAPABILITY_NOT_DECLARED', `the resolver declares ${capability} as L0 and cannot emit ${res.type} edges`, { language: extraction.language });
  }
  const from = checkShape(extraction, res);
  if (!from.ok) return from;
  const precision = checkPrecision(res, resolver);
  if (!precision.ok) return precision;
  const raw = res.raw.length > MAX_RAW ? `${res.raw.slice(0, MAX_RAW)}…` : res.raw;
  const site = OCCURRENCE_EDGE_TYPES.includes(res.type) ? siteHash(hasher, `${res.type}\n${rangeKey(res.range)}`) : '';
  const to =
    res.target.kind === 'symbol'
      ? (res.target.id as string as NodeId)
      : (`unres:${extraction.language}:${extraction.path}#${siteHash(hasher, `${res.type}\n${rangeKey(res.range)}\n${raw}`)}` as NodeId);
  const p = precision.value;
  return ok({
    type: res.type,
    from: from.value,
    to,
    toKind: res.target.kind,
    site,
    status: p === 'exact' ? 'verified' : p === 'heuristic' ? 'inferred' : 'unknown',
    precision: p,
    producer: producerRef(resolver.producer, resolver.profile, capability),
    evidence: { kind: p === 'exact' ? 'compiler' : p === 'heuristic' ? 'heuristic' : 'ast', path: extraction.path, range: { ...res.range }, contentHash: extraction.contentHash },
    attrs: { raw },
  });
}
