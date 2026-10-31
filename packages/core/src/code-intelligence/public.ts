// Published language of the code-intelligence context (FF-BND-001).
// P02-04 adds the FileExtractor and ProjectResolver ports and the LanguageRegistry.
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
export type { SymbolDeclaration, SymbolIdParts, SymbolKind } from './domain/symbol-identity.js';
export { DEFAULT_EXPORT_NAME, SYMBOL_KINDS, anonymousName, identifySymbols, parseSymbolId, validateNameSegment } from './domain/symbol-identity.js';
