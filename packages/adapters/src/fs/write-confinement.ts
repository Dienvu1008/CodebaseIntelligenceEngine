/**
 * WriteConfinement (SEC-002): the single gate every CIE writer must pass. CIE may write only under:
 *   - <workspace>/.cie/
 *   - <workspace>/<wikiDir>/ (when configured)
 * plus the SEC-002 write-exception register (SECURITY_AND_RELIABILITY §2):
 *   - the workspace .gitignore, only for the purpose 'init-gitignore' (an explicitly confirmed `cie init`)
 *   - an explicit --state-dir outside the workspace (benchmarks, read-only fixtures)
 *   - the user config directory (consent, settings)
 *
 * Checks are made on real paths: the deepest existing ancestor of the target is resolved, so a symlink
 * or junction inside .cie/ that points elsewhere cannot be used to escape.
 */
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { domainError, err, ok, type DomainError, type Result } from '@cie/core';

export type WritePurpose = 'state' | 'wiki' | 'init-gitignore' | 'user-config';

export interface WriteConfinementOptions {
  /** Workspace root (absolute). */
  readonly workspaceRoot: string;
  /** Workspace-relative wiki directory, if documentation writes are enabled. */
  readonly wikiDir?: string;
  /** Absolute state directory override (--state-dir). Defaults to <workspace>/.cie. */
  readonly stateDir?: string;
  /** Absolute user config directory. */
  readonly userConfigDir?: string;
}

const isWithin = (parent: string, child: string): boolean => {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Real path of `p`; for not-yet-existing paths, the real path of the deepest existing ancestor plus the rest. */
async function realTarget(p: string): Promise<string> {
  const abs = path.resolve(p);
  const missing: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(await realpath(cur), ...missing.reverse());
    } catch (e) {
      const parent = path.dirname(cur);
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || parent === cur) throw e;
      missing.push(path.basename(cur));
      cur = parent;
    }
  }
}

export class WriteConfinement {
  private constructor(private readonly roots: ReadonlyMap<WritePurpose, string>) {}

  static async create(opts: WriteConfinementOptions): Promise<WriteConfinement> {
    const workspaceReal = await realTarget(opts.workspaceRoot);
    const roots = new Map<WritePurpose, string>();
    const defaultState = path.join(workspaceReal, '.cie');
    const stateReal = await realTarget(opts.stateDir ?? defaultState);
    // A state dir equal to, above or anywhere inside the workspace (other than .cie) would make
    // workspace files writable, so it is refused as a configuration error.
    const isDefault = stateReal === defaultState;
    if (!isDefault && (isWithin(stateReal, workspaceReal) || isWithin(workspaceReal, stateReal))) {
      throw new Error('stateDir must be <workspace>/.cie or a directory entirely outside the workspace');
    }
    roots.set('state', stateReal);
    if (opts.wikiDir !== undefined) {
      const wiki = await realTarget(path.join(workspaceReal, opts.wikiDir));
      if (!isWithin(workspaceReal, wiki)) throw new Error('wikiDir must be inside the workspace');
      roots.set('wiki', wiki);
    }
    roots.set('init-gitignore', path.join(workspaceReal, '.gitignore'));
    if (opts.userConfigDir !== undefined) roots.set('user-config', await realTarget(opts.userConfigDir));
    return new WriteConfinement(roots);
  }

  /** Allows the write iff the target's real location is inside the root registered for `purpose`. */
  async check(target: string, purpose: WritePurpose): Promise<Result<string, DomainError>> {
    const root = this.roots.get(purpose);
    const deny = (reason: string): Result<never, DomainError> =>
      err(domainError('WRITE_NOT_PERMITTED', reason, { purpose, target: path.basename(target) }));
    if (root === undefined) return deny(`no write root is registered for purpose "${purpose}"`);
    let real: string;
    try {
      real = await realTarget(target);
    } catch {
      return deny('target path cannot be resolved');
    }
    if (purpose === 'init-gitignore') return real === root ? ok(real) : deny('only the workspace .gitignore may be written');
    if (!isWithin(root, real)) return deny('target lies outside the permitted write root');
    return ok(real);
  }
}
