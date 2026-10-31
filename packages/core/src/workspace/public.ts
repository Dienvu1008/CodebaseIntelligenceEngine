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
