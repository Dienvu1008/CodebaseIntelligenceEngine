/**
 * Workspace enumeration (FR-002..FR-007, WS-002, WS-004): walks the tree through the FileSystem port and
 * produces manifest entries.
 *
 * Determinism: directories are listed in code-unit order and entries are emitted in walk order. The manifest
 * builder sorts again anyway. Policies:
 *  - ignore rules follow IgnoreEvaluator (git-compatible), with CIE defaults and cie.config.json layers;
 *  - symlinks are never followed: inside the root they become 'symlink', outside 'symlink_escape'; size 0;
 *  - files above maxFileBytes become 'too_large' without being read; NUL bytes mean 'binary';
 *  - names that cannot be canonical paths are reported in `unrepresentable` and never enter the manifest;
 *  - .gitignore files themselves are regular files and are indexed like any other.
 */
import type { CancellationSignal, CanonicalPath, DomainError, Hasher, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import { decodeUtf8, languageForPath, looksBinary } from '../domain/file-classification.js';
import { CIE_DEFAULT_IGNORES, IgnoreEvaluator } from '../domain/ignore-evaluator.js';
import type { ManifestEntry } from '../domain/manifest.js';
import { canonicalizePath } from '../domain/path-canonicalizer.js';
import type { WorkspaceSettings } from '../domain/settings.js';
import type { DirEntry, FileSystem } from './ports.js';

export interface Unrepresentable {
  readonly parent: CanonicalPath | null;
  readonly name: string;
  readonly code: string;
}

export interface EnumerationResult {
  readonly entries: readonly ManifestEntry[];
  readonly unrepresentable: readonly Unrepresentable[];
  /** Directories that exist but could not be listed (permissions, races). Reported, never fatal. */
  readonly unlistable: readonly CanonicalPath[];
  readonly ignored: number;
}

export interface EnumerationDeps {
  readonly fs: FileSystem;
  readonly hasher: Hasher;
  readonly settings: WorkspaceSettings;
  readonly signal: CancellationSignal;
}

interface WalkState {
  readonly entries: ManifestEntry[];
  readonly unrepresentable: Unrepresentable[];
  readonly unlistable: CanonicalPath[];
  ignored: number;
}

const cancelled = (): Result<never, DomainError> => err(domainError('CANCELLED', 'enumeration was cancelled'));

async function withGitignore(
  deps: EnumerationDeps,
  dir: CanonicalPath | null,
  listing: readonly DirEntry[],
  ev: IgnoreEvaluator,
): Promise<IgnoreEvaluator> {
  if (!listing.some((e) => e.name === '.gitignore' && e.kind === 'file')) return ev;
  const path = canonicalizePath(dir === null ? '.gitignore' : `${dir}/.gitignore`);
  if (!path.ok) return ev;
  const bytes = await deps.fs.readFile(path.value, deps.signal);
  if (!bytes.ok) return ev;
  return ev.with({ layer: 'gitignore', base: dir, text: decodeUtf8(bytes.value), origin: path.value });
}

async function fileEntry(deps: EnumerationDeps, path: CanonicalPath): Promise<ManifestEntry> {
  const stat = await deps.fs.stat(path);
  if (stat === null) return { path, status: 'skipped', reason: 'unreadable', size: 0 };
  if (stat.size > deps.settings.maxFileBytes) return { path, status: 'skipped', reason: 'too_large', size: stat.size };
  const content = await deps.fs.readFile(path, deps.signal);
  if (!content.ok) return { path, status: 'skipped', reason: 'unreadable', size: stat.size };
  if (looksBinary(content.value)) return { path, status: 'skipped', reason: 'binary', size: content.value.length };
  return { path, status: 'indexed', hash: deps.hasher.sha256(content.value), size: content.value.length, language: languageForPath(path) };
}

async function symlinkEntry(deps: EnumerationDeps, path: CanonicalPath): Promise<ManifestEntry> {
  const real = await deps.fs.realpath(path);
  return { path, status: 'skipped', reason: real.kind === 'outside' ? 'symlink_escape' : 'symlink', size: 0 };
}

async function walk(deps: EnumerationDeps, dir: CanonicalPath | null, inherited: IgnoreEvaluator, state: WalkState): Promise<Result<void, DomainError>> {
  if (deps.signal.aborted) return cancelled();
  const listing = await deps.fs.list(dir, deps.signal);
  if (!listing.ok) {
    if (listing.error.code === 'FS_CANCELLED') return cancelled();
    if (dir === null) return listing;
    state.unlistable.push(dir);
    return ok(undefined);
  }
  const ev = await withGitignore(deps, dir, listing.value, inherited);
  for (const entry of listing.value) {
    if (deps.signal.aborted) return cancelled();
    const path = canonicalizePath(dir === null ? entry.name : `${dir}/${entry.name}`);
    if (!path.ok) {
      state.unrepresentable.push({ parent: dir, name: entry.name, code: path.error.code });
      continue;
    }
    const kind = entry.kind === 'directory' ? 'directory' : 'file'; // git treats symlinks like files for ignore rules
    if (ev.isIgnored(path.value, kind)) {
      state.ignored++;
      continue;
    }
    if (entry.kind === 'directory') {
      const sub = await walk(deps, path.value, ev, state);
      if (!sub.ok) return sub;
    } else if (entry.kind === 'file') {
      state.entries.push(await fileEntry(deps, path.value));
    } else if (entry.kind === 'symlink') {
      state.entries.push(await symlinkEntry(deps, path.value));
    }
    // 'other' (sockets, FIFOs, devices) is skipped silently: such entries are not content.
  }
  return ok(undefined);
}

export async function enumerateWorkspace(deps: EnumerationDeps): Promise<Result<EnumerationResult, DomainError>> {
  const base = IgnoreEvaluator.from([
    { layer: 'default', base: null, text: CIE_DEFAULT_IGNORES, origin: 'cie-defaults' },
    { layer: 'config', base: null, text: deps.settings.ignore.join('\n'), origin: 'cie.config.json' },
  ]);
  const state: WalkState = { entries: [], unrepresentable: [], unlistable: [], ignored: 0 };
  const r = await walk(deps, null, base, state);
  if (!r.ok) return r;
  return ok({ entries: state.entries, unrepresentable: state.unrepresentable, unlistable: state.unlistable, ignored: state.ignored });
}
