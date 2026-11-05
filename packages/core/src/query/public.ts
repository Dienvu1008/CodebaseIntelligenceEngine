// Application-level read side (BOUNDED_CONTEXTS §1). It has no domain/ folder by design for Phase 01;
// Phase 03 adds the bounded graph traversal domain and the GraphReadModel query use cases (KG-004).
export type {
  Direction,
  NeighborEdge,
  NeighborRequest,
  NeighborResult,
  ReachedNode,
  TraversalBounds,
  TraversalRequest,
  TraversalResult,
} from './domain/traversal.js';
export {
  clampBounds,
  DEFAULT_DEPTH,
  DEFAULT_LIMIT,
  DEPENDENCY_EDGE_TYPES,
  IMPACT_EDGE_TYPES,
  MAX_DEPTH_CAP,
  MAX_LIMIT_CAP,
  weakerStatus,
} from './domain/traversal.js';
export type { GraphReadModel } from './application/ports.js';
export type { GraphQueries, GraphQueryDeps, NodeQueryResult } from './application/graph-queries.js';
export { graphQueries, parseNodeId } from './application/graph-queries.js';
