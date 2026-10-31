// Published language of the knowledge context, including provenance (FF-BND-001).
// Phase 03: the RelationType registry (P03-04); KnowledgeClaim, Evidence and the GraphReadModel port follow.
export type {
  GraphNodeKind,
  RegisteredCodeEdgeType,
  RegisteredEdgeStatus,
  RelationFacts,
  RelationSignature,
  RelationStatus,
  RelationType,
  RelationTypeName,
} from './domain/relation-type.js';
export { GRAPH_NODE_KINDS, RELATION_STATUSES, RELATION_TYPES, isRelationTypeName, relationType, relationViolations } from './domain/relation-type.js';
