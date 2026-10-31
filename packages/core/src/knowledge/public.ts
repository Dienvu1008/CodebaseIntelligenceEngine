// Published language of the knowledge context, including provenance (FF-BND-001).
// Phase 03: the RelationType registry (P03-04) and claims with explicit evidence (P03-05).
// ClaimVerifier is deliberately absent: it is the `@cie/core/verification` subpath (DEPENDENCY_RULES C8).
// Only the token's *type* is published, so `markVerified` can be called but a token cannot be created.
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
export type {
  ClaimActor,
  ClaimNode,
  ClaimOrigin,
  ClaimStatus,
  Evidence,
  EvidenceInput,
  EvidenceKind,
  EvidenceLocator,
  ClaimFreshness,
  RevisionView,
} from './domain/provenance.js';
export {
  DETERMINISTIC_EVIDENCE_KINDS,
  EVIDENCE_KINDS,
  claimId,
  createEvidence,
  formatActor,
  formatOrigin,
  isDeterministic,
  qualifyingEvidence,
} from './domain/provenance.js';
export type { ClaimProposal, ClaimTransition, ProposedStatus, UserAssertion } from './domain/claim.js';
export { KnowledgeClaim } from './domain/claim.js';
export type { VerificationToken } from './domain/verification/claim-verifier.js';
