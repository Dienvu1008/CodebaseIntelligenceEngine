/**
 * Bounded graph traversal (KG-004, KNOWLEDGE_GRAPH_DESIGN §8). Every GraphReadModel query carries an
 * explicit `maxDepth` and `limit`, both clamped to server caps, and reports `truncated` when a bound is
 * hit. This module is the single definition of the bounds and the direction/relation vocabulary; the
 * SQLite adapter runs the recursive SQL, and the query use cases compose it.
 *
 * Pure, no I/O. Caps are generous but finite: a traversal can never load the whole graph (R-06).
 */
import type { NodeId } from '../../shared-kernel/index.js';
import type { CodeEdgeType } from '../../code-intelligence/public.js';

export const MAX_DEPTH_CAP = 10;
export const MAX_LIMIT_CAP = 1000;
export const DEFAULT_DEPTH = 3;
export const DEFAULT_LIMIT = 200;

/** Follow edges out of the start (`out`, dependencies/callees) or into it (`in`, dependents/callers). */
export type Direction = 'out' | 'in';

export interface TraversalBounds {
  readonly maxDepth: number;
  readonly limit: number;
}

/** Clamps caller-supplied bounds to [1, cap]; non-finite or missing values fall back to the defaults. */
export function clampBounds(input: Partial<TraversalBounds> | undefined): TraversalBounds {
  const clamp = (v: number | undefined, def: number, cap: number): number => {
    if (v === undefined || !Number.isFinite(v)) return def;
    return Math.min(cap, Math.max(1, Math.trunc(v)));
  };
  return { maxDepth: clamp(input?.maxDepth, DEFAULT_DEPTH, MAX_DEPTH_CAP), limit: clamp(input?.limit, DEFAULT_LIMIT, MAX_LIMIT_CAP) };
}

/** Edge types each CLI/read-model query follows (KNOWLEDGE_GRAPH_DESIGN §8.3, §8.4, §8.6, §8.8). */
export const DEPENDENCY_EDGE_TYPES: readonly CodeEdgeType[] = ['imports', 'imports_symbol'];
export const IMPACT_EDGE_TYPES: readonly CodeEdgeType[] = ['references', 'calls', 'imports_symbol', 'extends', 'implements', 'references_type'];

export interface NeighborRequest {
  readonly start: NodeId;
  readonly direction: Direction;
  /** Edge types to follow; empty means every type. */
  readonly types: readonly CodeEdgeType[];
  readonly limit: number;
}

export interface TraversalRequest extends TraversalBounds {
  readonly start: NodeId;
  readonly direction: Direction;
  readonly types: readonly CodeEdgeType[];
}

/** One node reached by a traversal, with the depth at which it was first reached and the weakest status to it. */
export interface ReachedNode {
  readonly id: NodeId;
  readonly depth: number;
  /** The weakest edge status along the shortest path (an inferred hop anywhere makes the whole path inferred). */
  readonly status: 'verified' | 'inferred' | 'user_asserted' | 'unknown';
}

export interface TraversalResult {
  readonly nodes: readonly ReachedNode[];
  readonly truncated: boolean;
}

export interface NeighborEdge {
  readonly type: CodeEdgeType;
  /** The node at the other end of the edge (the target for `out`, the source for `in`). */
  readonly node: NodeId;
  readonly status: 'verified' | 'inferred' | 'user_asserted' | 'unknown';
  readonly precision: 'exact' | 'heuristic' | null;
}

export interface NeighborResult {
  /** Edges grouped by type, each group capped at `limit`; a group reports `truncated` when it hit the cap. */
  readonly groups: readonly { readonly type: CodeEdgeType; readonly edges: readonly NeighborEdge[]; readonly truncated: boolean }[];
}

/** The weaker of two statuses (verified < inferred/user_asserted < unknown), for impact-path labelling. */
const STATUS_RANK: Readonly<Record<ReachedNode['status'], number>> = { verified: 0, inferred: 1, user_asserted: 1, unknown: 2 };
export function weakerStatus(a: ReachedNode['status'], b: ReachedNode['status']): ReachedNode['status'] {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}
