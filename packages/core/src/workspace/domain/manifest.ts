/**
 * SnapshotManifest (DOMAIN_MODEL §4) and its deterministic builder (WS-004).
 *
 * The manifest is a value object: entries sorted by path (UTF-16 code units) plus a manifestHash over a
 * canonical text serialization. For an identical tree and configuration, the serialization and the hash
 * are byte-identical regardless of input order, OS or locale.
 */
import type { CanonicalPath, ContentHash, DomainError, Hasher, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import { compareCanonicalPaths } from './path-canonicalizer.js';

/** Why a file present in the tree is not indexed (FR-007). Values are stable: they are serialized. */
export type SkipReason = 'too_large' | 'binary' | 'symlink_escape' | 'non_portable_name' | 'unreadable';

export type ManifestEntry =
  | {
      readonly path: CanonicalPath;
      readonly status: 'indexed';
      readonly hash: ContentHash;
      readonly size: number;
      /** Adapter language id (e.g. 'ts', 'py'), or null when no adapter claims the file. */
      readonly language: string | null;
    }
  | {
      readonly path: CanonicalPath;
      readonly status: 'skipped';
      readonly reason: SkipReason;
      readonly size: number;
    };

export interface SnapshotManifest {
  readonly entries: readonly ManifestEntry[];
  readonly manifestHash: ContentHash;
}

/** Serialization format version. Bump it when serializeEntry changes, because the hash changes. */
export const MANIFEST_FORMAT = 'cie-manifest/1';

function serializeEntry(e: ManifestEntry): string {
  // Canonical paths cannot contain tabs or newlines (PathCanonicalizer rejects control characters),
  // so tab-separated lines are unambiguous.
  return e.status === 'indexed'
    ? `${e.path}\tindexed\t${e.hash}\t${e.size}\t${e.language ?? ''}\n`
    : `${e.path}\tskipped\t${e.reason}\t${e.size}\t\n`;
}

export function serializeManifest(entries: readonly ManifestEntry[]): string {
  return `${MANIFEST_FORMAT}\n${entries.map(serializeEntry).join('')}`;
}

export function buildManifest(input: readonly ManifestEntry[], hasher: Hasher): Result<SnapshotManifest, DomainError> {
  const entries = [...input].sort((a, b) => compareCanonicalPaths(a.path, b.path));
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (prev !== undefined && cur !== undefined && prev.path === cur.path) {
      return err(domainError('MANIFEST_DUPLICATE_PATH', 'the same path appears twice in the manifest', { path: cur.path }));
    }
  }
  for (const e of entries) {
    if (!Number.isSafeInteger(e.size) || e.size < 0) {
      return err(domainError('MANIFEST_INVALID_SIZE', 'file size must be a non-negative integer', { path: e.path, size: e.size }));
    }
  }
  return ok({ entries, manifestHash: hasher.sha256Text(serializeManifest(entries)) });
}
