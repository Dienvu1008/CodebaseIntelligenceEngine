/**
 * RelationType registry (KNOWLEDGE_GRAPH_DESIGN §3, KG-002). The single definition of which relation types
 * exist, which (from kind, to kind) pairs each one connects, which statuses it may carry and whether it is
 * occurrence-based (identified per site). Every edge and, from P03-05, every claim is checked against it:
 * at construction where the producer can import this context, and by the RevisionValidator on stored rows.
 *
 * Deviations from the §3 baseline table, recorded in the design doc:
 *  - there is no `file` node kind: a file's language view is its `module` node, so `file → symbol`
 *    containment is `defines`, and `belongs_to` starts from directory, package or module;
 *  - `imports_symbol` also targets `unresolved` placeholders with status `unknown` (SY-006, Phase 02);
 *  - the Phase 01 structural kinds are `directory`, `package` and `project`;
 *  - (P03-07) `references`, `references_type` and `calls` may start at a module (top-level code);
 *    `references` and `references_type` are one edge per (from, to) with an occurrence count, and only
 *    `calls` is identified per site.
 */
import type { CodeEdgeType, CodeNodeKind, EdgeStatus } from '../../code-intelligence/public.js';
import type { StructuralKind } from '../../workspace/public.js';

/** Every node kind a relation can connect: stored today (structural, code) or introduced by later phases. */
export type GraphNodeKind = StructuralKind | CodeNodeKind | 'concept' | 'component' | 'layer' | 'page';
export const GRAPH_NODE_KINDS: readonly GraphNodeKind[] = [
  'directory',
  'package',
  'project',
  'module',
  'symbol',
  'external',
  'unresolved',
  'concept',
  'component',
  'layer',
  'page',
];

export type RelationStatus = 'verified' | 'inferred' | 'user_asserted' | 'unknown';
export const RELATION_STATUSES: readonly RelationStatus[] = ['verified', 'inferred', 'user_asserted', 'unknown'];

export type RelationTypeName =
  | 'contains'
  | 'defines'
  | 'exports'
  | 'imports'
  | 'imports_symbol'
  | 'references'
  | 'calls'
  | 'may_dispatch_to'
  | 'extends'
  | 'implements'
  | 'references_type'
  | 'injects'
  | 'depends_on'
  | 'belongs_to'
  | 'violates'
  | 'describes'
  | 'mentions'
  | 'implements_concept'
  | 'related_to'
  | 'part_of'
  | 'flow_step'
  | 'lineage';

export interface RelationSignature {
  readonly from: GraphNodeKind;
  readonly to: GraphNodeKind;
}

export interface RelationType {
  readonly name: RelationTypeName;
  readonly semantics: string;
  /** Allowed (from kind, to kind) pairs. */
  readonly signatures: readonly RelationSignature[];
  readonly allowedStatuses: readonly RelationStatus[];
  /** Occurrence-based types are identified per site (non-empty site key); all others have an empty site key. */
  readonly occurrence: boolean;
  /** Phase that introduces the type. Earlier phases never produce it. */
  readonly since: number;
}

// Compile-time links to the producers' vocabularies: a code edge type or status that the registry does
// not know, or a structural/code node kind missing from GraphNodeKind, fails to compile.
type Covers<Super, Sub extends Super> = Sub;
export type RegisteredCodeEdgeType = Covers<RelationTypeName, CodeEdgeType>;
export type RegisteredEdgeStatus = Covers<RelationStatus, EdgeStatus>;

const V = 'verified';
const I = 'inferred';
const U = 'user_asserted';
const Q = 'unknown';
const pairs = (from: readonly GraphNodeKind[], to: readonly GraphNodeKind[]): RelationSignature[] => from.flatMap((f) => to.map((t) => ({ from: f, to: t })));

function type(
  name: RelationTypeName,
  since: number,
  signatures: readonly RelationSignature[],
  allowedStatuses: readonly RelationStatus[],
  semantics: string,
  occurrence = false,
): RelationType {
  return Object.freeze({ name, semantics, signatures: Object.freeze([...signatures]), allowedStatuses: Object.freeze([...allowedStatuses]), occurrence, since });
}

/** The registry, in §3 order. */
export const RELATION_TYPES: readonly RelationType[] = Object.freeze([
  type('contains', 2, [...pairs(['directory'], ['directory']), ...pairs(['package'], ['directory']), ...pairs(['symbol'], ['symbol'])], [V], 'Lexical or physical containment'),
  type('defines', 2, pairs(['module'], ['symbol']), [V], 'Module-level definition'),
  type('exports', 2, pairs(['module'], ['symbol']), [V, I], 'The symbol is exported from the module (re-exports carry `via`)'),
  type('imports', 2, pairs(['module'], ['module', 'external', 'unresolved']), [V, I, Q], 'Static import dependency (`isTypeOnly`, `isDynamic` attributes)'),
  type('imports_symbol', 2, pairs(['module'], ['symbol', 'unresolved']), [V, I, Q], 'Named import binding'),
  type('references', 3, pairs(['symbol', 'module'], ['symbol']), [V, I], "Identifier occurrences in `from`'s body (or top-level code) resolve to `to` (count in `occurrences`)"),
  type('calls', 3, pairs(['symbol', 'module'], ['symbol', 'unresolved']), [V, I, Q], 'A static call expression targets `to` (one edge per call site)', true),
  type('may_dispatch_to', 3, pairs(['symbol'], ['symbol']), [I], 'A virtual or interface call may reach an implementer (methods only)'),
  type('extends', 3, pairs(['symbol'], ['symbol']), [V, I], 'Class or interface inheritance'),
  type('implements', 3, pairs(['symbol'], ['symbol']), [V], 'A class implements an interface'),
  type('references_type', 3, pairs(['symbol', 'module'], ['symbol']), [V, I], 'Type-position references (count in `occurrences`)'),
  type('injects', 3, pairs(['symbol'], ['symbol']), [I], 'Dependency-injection wiring (constructor injection and similar)'),
  type('depends_on', 8, [...pairs(['component'], ['component']), ...pairs(['package'], ['package'])], [V, I], 'Aggregated dependency derived from `imports` (verified only from verified edges)'),
  type('belongs_to', 8, [...pairs(['directory', 'package', 'module'], ['component']), ...pairs(['component'], ['layer'])], [V, U], 'Architecture membership'),
  type('violates', 8, pairs(['component'], ['component']), [V], 'A `depends_on` edge breaks a declared layer rule'),
  type('describes', 4, pairs(['page'], ['concept', 'symbol', 'component']), [U, I], 'The page is about the target'),
  type('mentions', 4, pairs(['page'], GRAPH_NODE_KINDS), [V], 'The page links to the target (link resolution)'),
  type('implements_concept', 4, pairs(['symbol', 'module', 'component'], ['concept']), [U, I, Q], 'The code realizes the concept'),
  type('related_to', 4, pairs(['concept'], ['concept']), [U, I], 'Generic association'),
  type('part_of', 4, pairs(['concept'], ['concept']), [U, I], 'Concept hierarchy'),
  type('flow_step', 8, pairs(['symbol'], ['symbol']), [V, I], 'An ordered step of a declared or traced execution flow (`flowId`, `order`)'),
  type('lineage', 5, pairs(['symbol'], ['symbol']), [V], 'Identity change: moved or renamed (SY-004)'),
]);

const BY_NAME: ReadonlyMap<string, RelationType> = new Map(RELATION_TYPES.map((t) => [t.name, t]));

export function relationType(name: string): RelationType | null {
  return BY_NAME.get(name) ?? null;
}

export function isRelationTypeName(name: string): name is RelationTypeName {
  return BY_NAME.has(name);
}

/** A relation as KG-002 sees it: endpoint kinds as stored, not ids. `site` is checked when given. */
export interface RelationFacts {
  readonly type: string;
  readonly fromKind: string;
  readonly toKind: string;
  readonly status: string;
  readonly site?: string;
}

/** KG-002 validator: the type is registered, the endpoint kinds match a signature and the status is allowed. */
export function relationViolations(r: RelationFacts, label = `${r.type} ${r.fromKind} -> ${r.toKind}`): readonly string[] {
  const t = BY_NAME.get(r.type);
  if (t === undefined) return [`KG-002: ${label}: relation type "${r.type}" is not registered`];
  const out: string[] = [];
  if (!t.signatures.some((s) => s.from === r.fromKind && s.to === r.toKind)) {
    out.push(`KG-002: ${label}: ${r.type} does not connect ${r.fromKind} -> ${r.toKind}`);
  }
  if (!(t.allowedStatuses as readonly string[]).includes(r.status)) {
    out.push(`KG-002: ${label}: status ${r.status} is not allowed for ${r.type} (allowed: ${t.allowedStatuses.join(', ')})`);
  }
  if (r.site !== undefined && (r.site !== '') !== t.occurrence) {
    out.push(`KG-002: ${label}: ${r.type} ${t.occurrence ? 'is occurrence-based and needs a site key' : 'has no site key'}`);
  }
  return out;
}
