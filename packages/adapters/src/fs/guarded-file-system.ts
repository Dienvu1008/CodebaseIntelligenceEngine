/**
 * GuardedFileSystem (WS-002 b/c): read-only access confined to the real path of the workspace root.
 *
 * Every read resolves the real path first (following symlinks and Windows junctions) and refuses
 * anything outside the root. Paths never leave this adapter in absolute form: the core sees only
 * CanonicalPaths.
 *
 * Known limitation (PHASE_01_SIGNOFF): the realpath check and the read are two separate system calls,
 * so a concurrent attacker who swaps a path component for a symlink between them could race the check
 * (TOCTOU). CIE's threat model treats repository *content* as untrusted, not concurrent local
 * processes; mitigating that would require O_NOFOLLOW-style per-component opens, which Node does not
 * offer portably.
 */
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalizePath,
  domainError,
  err,
  ok,
  type CancellationSignal,
  type CanonicalPath,
  type DirEntry,
  type DomainError,
  type EntryKind,
  type FileStat,
  type FileSystem,
  type RealPathResult,
  type Result,
} from '@cie/core';

const isNotFound = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

function kindOf(s: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): EntryKind {
  if (s.isSymbolicLink()) return 'symlink';
  if (s.isFile()) return 'file';
  if (s.isDirectory()) return 'directory';
  return 'other';
}

function ioError(e: unknown, p: string | null): DomainError {
  return domainError('FS_IO_ERROR', 'file system operation failed', {
    path: p,
    code: (e as NodeJS.ErrnoException | undefined)?.code ?? 'UNKNOWN',
  });
}

const cancelled = (p: string | null): Result<never, DomainError> =>
  err(domainError('FS_CANCELLED', 'operation was cancelled', { path: p }));

export class GuardedFileSystem implements FileSystem {
  private constructor(private readonly rootReal: string) {}

  /** `root` may itself be reached through a symlink or junction; it is resolved once, here. */
  static async open(root: string): Promise<GuardedFileSystem> {
    return new GuardedFileSystem(await realpath(path.resolve(root)));
  }

  /** Absolute real path of the root. For composition-root use only; never passed into the core. */
  get root(): string {
    return this.rootReal;
  }

  private toAbsolute(p: CanonicalPath | null): string {
    return p === null ? this.rootReal : path.join(this.rootReal, ...p.split('/'));
  }

  /** Canonical path of an absolute real path, or null if it is not strictly inside the root. */
  private insideRoot(real: string): CanonicalPath | null {
    const rel = path.relative(this.rootReal, real);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const c = canonicalizePath(rel);
    return c.ok ? c.value : null;
  }

  async realpath(p: CanonicalPath): Promise<RealPathResult> {
    let real: string;
    try {
      real = await realpath(this.toAbsolute(p));
    } catch (e) {
      if (isNotFound(e)) return { kind: 'missing' };
      throw e;
    }
    const inside = this.insideRoot(real);
    return inside === null ? { kind: 'outside' } : { kind: 'inside', path: inside };
  }

  async stat(p: CanonicalPath): Promise<FileStat | null> {
    try {
      const s = await lstat(this.toAbsolute(p));
      return { kind: kindOf(s), size: s.size, mtimeMs: s.mtimeMs };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  async readFile(p: CanonicalPath, signal: CancellationSignal): Promise<Result<Uint8Array, DomainError>> {
    if (signal.aborted) return cancelled(p);
    const resolved = await this.realpath(p);
    if (resolved.kind === 'missing') return err(domainError('FS_NOT_FOUND', 'file not found', { path: p }));
    if (resolved.kind === 'outside') {
      return err(domainError('FS_OUTSIDE_ROOT', 'path resolves outside the workspace root', { path: p }));
    }
    try {
      const real = this.toAbsolute(resolved.path);
      const s = await lstat(real);
      if (!s.isFile()) return err(domainError('FS_NOT_A_FILE', 'path is not a regular file', { path: p }));
      return ok(new Uint8Array(await readFile(real)));
    } catch (e) {
      return err(isNotFound(e) ? domainError('FS_NOT_FOUND', 'file not found', { path: p }) : ioError(e, p));
    }
  }

  async list(dir: CanonicalPath | null, signal: CancellationSignal): Promise<Result<readonly DirEntry[], DomainError>> {
    if (signal.aborted) return cancelled(dir);
    if (dir !== null) {
      const resolved = await this.realpath(dir);
      if (resolved.kind === 'missing') return err(domainError('FS_NOT_FOUND', 'directory not found', { path: dir }));
      if (resolved.kind === 'outside') {
        return err(domainError('FS_OUTSIDE_ROOT', 'path resolves outside the workspace root', { path: dir }));
      }
    }
    try {
      const entries = await readdir(this.toAbsolute(dir), { withFileTypes: true });
      return ok(
        entries
          .map((d): DirEntry => ({ name: d.name, kind: kindOf(d) }))
          .sort((a, b) => (a.name === b.name ? 0 : a.name < b.name ? -1 : 1)),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOTDIR') {
        return err(domainError('FS_NOT_A_DIRECTORY', 'path is not a directory', { path: dir }));
      }
      return err(isNotFound(e) ? domainError('FS_NOT_FOUND', 'directory not found', { path: dir }) : ioError(e, dir));
    }
  }
}
