/**
 * Workspace ports needed by Phase 01 (SYSTEM_ARCHITECTURE §7). Phase 00 declares types only; there are
 * no implementations here. Phase 01 may refine these signatures while implementing the adapters, and
 * must record any change in its sign-off.
 */
import type {
  CancellationSignal,
  CanonicalPath,
  DomainError,
  Result,
  WorkspaceId,
} from '../../shared-kernel/index.js';

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

export interface FileStat {
  readonly kind: EntryKind;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface DirEntry {
  readonly name: string;
  readonly kind: EntryKind;
}

/**
 * Result of resolving a path's real location. Absolute OS paths never enter the core: the adapter
 * reports only whether the real path stays inside the workspace root (WS-002).
 */
export type RealPathResult =
  | { readonly kind: 'inside'; readonly path: CanonicalPath }
  | { readonly kind: 'outside' }
  | { readonly kind: 'missing' };

/** Read-only, root-confined file access. Guarded writers are separate ports (e.g. PageStore, Phase 04). */
export interface FileSystem {
  readFile(path: CanonicalPath, signal: CancellationSignal): Promise<Uint8Array>;
  stat(path: CanonicalPath): Promise<FileStat | null>;
  realpath(path: CanonicalPath): Promise<RealPathResult>;
  list(dir: CanonicalPath, signal: CancellationSignal): Promise<readonly DirEntry[]>;
}

/** Non-sensitive settings allowed in the workspace's cie.config.json (SEC-005 allow-list, finalized in Phase 01). */
export interface WorkspaceSettings {
  readonly ignore: readonly string[];
  readonly maxFileBytes: number | undefined;
  readonly wikiDir: string | undefined;
}

/** Security-sensitive settings. They are read only from user-level configuration, never from the workspace (SEC-005). */
export interface UserSettings {
  readonly llmProvider: 'none' | 'ollama' | 'openai-compatible';
  readonly publishGenerated: boolean;
}

export interface ConfigSource {
  /** Rejects (error result) a workspace config that contains sensitive or unknown keys. */
  workspace(): Promise<Result<WorkspaceSettings, DomainError>>;
  user(): Promise<Result<UserSettings, DomainError>>;
}

export interface WorkspaceIdentity {
  readonly id: WorkspaceId;
  /** ISO-8601, informational. */
  readonly createdAt: string;
}

/** Persists the identity in `.cie/workspace.json` and binds stores to it (WS-003). */
export interface WorkspaceRepository {
  load(): Promise<WorkspaceIdentity | null>;
  initialize(identity: WorkspaceIdentity): Promise<Result<void, DomainError>>;
}
