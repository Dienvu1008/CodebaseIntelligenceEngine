/**
 * Read-model ports of the query context (BOUNDED_CONTEXTS §1). All reads are pinned to a published
 * RevisionSeq and bounded (KG-004). The SQLite adapter implements them; the query use cases compose them.
 */
import type { DomainError, NodeId, Result, RevisionSeq } from '../../shared-kernel/index.js';
import type { NeighborRequest, NeighborResult, TraversalRequest, TraversalResult } from '../domain/traversal.js';

export interface GraphReadModel {
  /**
   * Nodes reachable from `start` by following `request.types` in `request.direction`, up to `maxDepth` and
   * `limit`. `truncated` is true when the depth or row bound cut the result. A start node that is not
   * visible at `seq` yields an empty result (not an error).
   */
  traverse(seq: RevisionSeq, request: TraversalRequest): Promise<Result<TraversalResult, DomainError>>;
  /** One hop in or out of `start` over the requested types, grouped and capped per type (KG §8.8). */
  neighbors(seq: RevisionSeq, request: NeighborRequest): Promise<Result<NeighborResult, DomainError>>;
  /** True when `start` is a node visible at `seq` (so a CLI can tell "no edges" from "unknown symbol"). */
  nodeExists(seq: RevisionSeq, start: NodeId): Promise<Result<boolean, DomainError>>;
}
