/**
 * Graph query use cases (KNOWLEDGE_GRAPH_DESIGN §8.3, §8.4, §8.6, §8.8) over a GraphReadModel. Each one
 * clamps its bounds (KG-004), resolves the start node's existence so a caller can distinguish "no results"
 * from "unknown node", and returns the read model's bounded result.
 *
 *  - deps: outgoing import dependencies (modules a start depends on).
 *  - dependents: incoming import dependencies.
 *  - refs: one hop of incoming references and calls (who uses a symbol).
 *  - impact: reverse closure over reference, call and type edges (what a change could affect), each entry
 *    labelled with the weakest status along its path.
 *  - neighbors: one hop in or out over the requested types, grouped per type.
 */
import type { DomainError, NodeId, Result, RevisionSeq } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import type { CodeEdgeType } from '../../code-intelligence/public.js';
import type { GraphReadModel } from './ports.js';
import {
  clampBounds,
  DEPENDENCY_EDGE_TYPES,
  IMPACT_EDGE_TYPES,
  type Direction,
  type NeighborResult,
  type TraversalBounds,
  type TraversalResult,
} from '../domain/traversal.js';

export interface GraphQueryDeps {
  readonly graph: GraphReadModel;
}

/** A traversal result tagged with whether the start node was found; `found: false` means an unknown node. */
export interface NodeQueryResult extends TraversalResult {
  readonly found: boolean;
}

async function traverseFrom(
  deps: GraphQueryDeps,
  seq: RevisionSeq,
  start: NodeId,
  direction: Direction,
  types: readonly CodeEdgeType[],
  bounds: Partial<TraversalBounds> | undefined,
): Promise<Result<NodeQueryResult, DomainError>> {
  const exists = await deps.graph.nodeExists(seq, start);
  if (!exists.ok) return exists;
  if (!exists.value) return ok({ found: false, nodes: [], truncated: false });
  const result = await deps.graph.traverse(seq, { start, direction, types, ...clampBounds(bounds) });
  if (!result.ok) return result;
  return ok({ found: true, ...result.value });
}

export const graphQueries = (deps: GraphQueryDeps) => ({
  /** Modules `start` depends on, following imports outward. */
  deps: (seq: RevisionSeq, start: NodeId, bounds?: Partial<TraversalBounds>) => traverseFrom(deps, seq, start, 'out', DEPENDENCY_EDGE_TYPES, bounds),
  /** Modules that depend on `start`, following imports inward. */
  dependents: (seq: RevisionSeq, start: NodeId, bounds?: Partial<TraversalBounds>) => traverseFrom(deps, seq, start, 'in', DEPENDENCY_EDGE_TYPES, bounds),
  /** One hop of references and calls into `start`: who uses it. */
  refs: (seq: RevisionSeq, start: NodeId, bounds?: Partial<TraversalBounds>) => traverseFrom(deps, seq, start, 'in', ['references', 'calls'], { ...bounds, maxDepth: 1 }),
  /** Reverse closure over reference, call and type edges: what a change to `start` could affect. */
  impact: (seq: RevisionSeq, start: NodeId, bounds?: Partial<TraversalBounds>) => traverseFrom(deps, seq, start, 'in', IMPACT_EDGE_TYPES, bounds),
  /** One hop in or out of `start` over `types` (empty = every type), grouped per type. */
  async neighbors(seq: RevisionSeq, start: NodeId, direction: Direction, types: readonly CodeEdgeType[], limit?: number): Promise<Result<{ found: boolean; result: NeighborResult }, DomainError>> {
    const exists = await deps.graph.nodeExists(seq, start);
    if (!exists.ok) return exists;
    if (!exists.value) return ok({ found: false, result: { groups: [] } });
    const { limit: capped } = clampBounds(limit === undefined ? {} : { limit });
    const result = await deps.graph.neighbors(seq, { start, direction, types, limit: capped });
    if (!result.ok) return result;
    return ok({ found: true, result: result.value });
  },
});

export type GraphQueries = ReturnType<typeof graphQueries>;

/** Parses a NodeId from CLI input: a symbol id or a `mod:`/`ext:`/`unres:` node id; rejects empty input. */
export function parseNodeId(raw: string): Result<NodeId, DomainError> {
  const trimmed = raw.trim();
  if (trimmed === '') return err(domainError('QUERY_NODE_INVALID', 'a node id is required'));
  return ok(trimmed as NodeId);
}
