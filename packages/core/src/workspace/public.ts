// Published language of the workspace context. Other contexts may import only from this file (FF-BND-001).
export type {
  ConfigSource,
  DirEntry,
  EntryKind,
  FileManifestReader,
  FileStat,
  FileSystem,
  RealPathResult,
  UserSettings,
  WorkspaceIdentity,
  WorkspaceRepository,
  WorkspaceSettings,
} from './application/ports.js';
export type { EnumerationDeps, EnumerationResult, Unrepresentable } from './application/enumerate.js';
export { enumerateWorkspace } from './application/enumerate.js';
export { BINARY_SNIFF_BYTES, decodeUtf8, languageForPath, looksBinary } from './domain/file-classification.js';
export type {
  EntryKind as IgnoreEntryKind,
  IgnoreDecision,
  IgnoreLayer,
  IgnoreRule,
  IgnoreSource,
} from './domain/ignore-evaluator.js';
export { CIE_DEFAULT_IGNORES, IgnoreEvaluator } from './domain/ignore-evaluator.js';
export type { ManifestEntry, SkipReason, SnapshotManifest } from './domain/manifest.js';
export { MANIFEST_FORMAT, buildManifest, serializeManifest } from './domain/manifest.js';
export type { PathErrorCode } from './domain/path-canonicalizer.js';
export { canonicalizePath, compareCanonicalPaths } from './domain/path-canonicalizer.js';
export type { LlmProviderSetting } from './domain/settings.js';
export {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_USER_SETTINGS,
  DEFAULT_WORKSPACE_SETTINGS,
  MAX_MAX_FILE_BYTES,
  parseUserSettings,
  parseWorkspaceSettings,
} from './domain/settings.js';
export type { Ecosystem, StructuralKind, StructuralNode } from './domain/structure.js';
export { deriveStructure } from './domain/structure.js';
