// Published language of the code-intelligence context (FF-BND-001).
export type { LanguageRegistryInput } from './application/language-registry.js';
export { LanguageRegistry } from './application/language-registry.js';
export type {
  CodeGraphReader,
  FileExtractor,
  FileInput,
  LanguageAdapter,
  ProjectDescriptor,
  ProjectInput,
  ProjectResolution,
  ProjectResolver,
  SymbolHit,
  SymbolQuery,
  SymbolSearch,
} from './application/ports.js';
export { DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, MAX_SEARCH_TERMS, MAX_TERM_LENGTH, clampSearchLimit, identifierWords, searchTerms } from './domain/symbol-search.js';
export type { LanguageDefinition } from './domain/languages.js';
export { MVP_LANGUAGES, extensionOf } from './domain/languages.js';
export type { Capability, CapabilityProfile, Fidelity, LanguageId, Precision, ProducerIdentity, ProducerRef } from './domain/capability.js';
export {
  CAPABILITIES,
  FIDELITIES,
  atLeast,
  capabilityProfile,
  formatProducer,
  languageId,
  maxPrecision,
  precisionAllowed,
  producerIdentity,
  producerRef,
} from './domain/capability.js';
export type {
  ExtractedImport,
  ExtractedSymbol,
  ExtractionDiagnostic,
  FileExtraction,
  FileExtractionInput,
  ImportDraft,
  ImportSpecifier,
  SymbolDraft,
} from './domain/file-extraction.js';
export { createFileExtraction } from './domain/file-extraction.js';
export type { EdgeStatus, ExternalEcosystem, ImportEdgeType, ImportResolution, ImportResolver, ImportTarget, StructuralEdge } from './domain/import-edge.js';
export { createImportEdge, externalNodeId, importEdgeViolations, moduleNodeId, unresolvedNodeId } from './domain/import-edge.js';
export type { RelationEdge, RelationEdgeType, RelationResolution, ResolvedEdge } from './domain/relation-edge.js';
export { createRelationEdge, isRelationEdge, OCCURRENCE_EDGE_TYPES, RELATION_CAPABILITY, RELATION_EDGE_TYPES } from './domain/relation-edge.js';
export type { SymbolDeclaration, SymbolIdParts, SymbolKind } from './domain/symbol-identity.js';
export { DEFAULT_EXPORT_NAME, SYMBOL_KINDS, anonymousName, encodeNameSegment, identifySymbols, parseSymbolId, validateNameSegment } from './domain/symbol-identity.js';
export type { CodeEdge, CodeEdgeType, CodeGraph, CodeNode, CodeNodeKind, EdgeEvidence, ProjectionDiagnostic, SourceFileFacts, SymbolFacts } from './domain/graph-projection.js';
export { CODE_EDGE_TYPES, CODE_NODE_KINDS, RESOLVED_EDGE_TYPES, edgeIdentity, projectCodeGraph } from './domain/graph-projection.js';
export type { SpannedRecord } from './domain/source-text.js';
export { SourceText, spanViolations } from './domain/source-text.js';
