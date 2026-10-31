// SEC-002: no code execution, confined writes.
//  - Writes: every writer goes through WriteConfinement, which permits only .cie/, the wiki directory and
//    the registered exceptions, checked on real paths.
//  - Spawning: node:child_process is confined to adapters/process and packages/client by FF-DEP-007.
//    tests/fitness/depcruise-rules.spec.ts proves that rule fires and that the real tree is clean.
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WriteConfinement } from '@cie/adapters';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { linkDir } from '../../helpers/links.js';
import { repoPath } from '../../helpers/repo.js';

let sandbox: string;
let ws: string;
let guard: WriteConfinement;

beforeAll(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'cie-sec002-'));
  ws = path.join(sandbox, 'ws');
  mkdirSync(path.join(ws, '.cie'), { recursive: true });
  mkdirSync(path.join(ws, 'docs', 'wiki'), { recursive: true });
  mkdirSync(path.join(sandbox, 'elsewhere'), { recursive: true });
  linkDir(path.join(sandbox, 'elsewhere'), path.join(ws, '.cie', 'sneaky')); // link inside .cie pointing out
  guard = await WriteConfinement.create({ workspaceRoot: ws, wikiDir: 'docs/wiki', userConfigDir: path.join(sandbox, 'user-config') });
});
afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const allowed = async (target: string, purpose: Parameters<WriteConfinement['check']>[1]): Promise<boolean> =>
  (await guard.check(target, purpose)).ok;

describe('SEC-002: write confinement', () => {
  it('permits writes under .cie/ and the wiki directory, including files that do not exist yet', async () => {
    expect(await allowed(path.join(ws, '.cie', 'index.db'), 'state')).toBe(true);
    expect(await allowed(path.join(ws, '.cie', 'new', 'deep', 'x.json'), 'state')).toBe(true);
    expect(await allowed(path.join(ws, 'docs', 'wiki', 'concepts', 'a.md'), 'wiki')).toBe(true);
  });

  it('refuses source files, the root, and paths that climb out', async () => {
    expect(await allowed(path.join(ws, 'src', 'index.ts'), 'state')).toBe(false);
    expect(await allowed(ws, 'state')).toBe(false);
    expect(await allowed(path.join(ws, '.cie', '..', 'src', 'x.ts'), 'state')).toBe(false);
    expect(await allowed(path.join(ws, 'docs', 'wiki', '..', 'other.md'), 'wiki')).toBe(false);
    expect(await allowed(path.join(sandbox, 'elsewhere', 'x'), 'state')).toBe(false);
  });

  it('refuses to follow a link inside .cie/ that points outside', async () => {
    expect(await allowed(path.join(ws, '.cie', 'sneaky', 'payload.txt'), 'state')).toBe(false);
  });

  it('does not let one purpose write into another purpose root', async () => {
    expect(await allowed(path.join(ws, 'docs', 'wiki', 'a.md'), 'state')).toBe(false);
    expect(await allowed(path.join(ws, '.cie', 'x'), 'wiki')).toBe(false);
  });

  it('permits the .gitignore exception only for its own purpose and only that exact file', async () => {
    expect(await allowed(path.join(ws, '.gitignore'), 'init-gitignore')).toBe(true);
    expect(await allowed(path.join(ws, 'src', '.gitignore'), 'init-gitignore')).toBe(false);
    expect(await allowed(path.join(ws, '.gitignore'), 'state')).toBe(false);
  });

  it('permits the user config directory only for user-config writes', async () => {
    expect(await allowed(path.join(sandbox, 'user-config', 'consent.json'), 'user-config')).toBe(true);
    expect(await allowed(path.join(sandbox, 'user-config', 'consent.json'), 'state')).toBe(false);
  });

  it('accepts an explicit --state-dir outside the workspace', async () => {
    const outsideState = path.join(sandbox, 'state');
    const g = await WriteConfinement.create({ workspaceRoot: ws, stateDir: outsideState });
    expect((await g.check(path.join(outsideState, 'index.db'), 'state')).ok).toBe(true);
    expect((await g.check(path.join(ws, '.cie', 'index.db'), 'state')).ok).toBe(false);
  });

  it.each([
    ['the workspace root', (w: string) => w],
    ['a parent of the workspace', (w: string) => path.dirname(w)],
    ['a source folder inside the workspace', (w: string) => path.join(w, 'src')],
  ])('rejects --state-dir set to %s', async (_label, pick) => {
    await expect(WriteConfinement.create({ workspaceRoot: ws, stateDir: pick(ws) })).rejects.toThrow(/stateDir/);
  });

  it('rejects a wiki directory that climbs out of the workspace', async () => {
    await expect(WriteConfinement.create({ workspaceRoot: ws, wikiDir: '../outside-wiki' })).rejects.toThrow(/wikiDir/);
  });
});

describe('SEC-002: process spawning stays confined', () => {
  it('keeps the FF-DEP-007 child_process rule in the dependency-cruiser configuration', () => {
    const require = createRequire(import.meta.url);
    const config = require(repoPath('.dependency-cruiser.cjs')) as { forbidden: Array<{ name: string }> };
    expect(config.forbidden.map((r) => r.name)).toContain('FF-DEP-007-child-process-confined');
  });
});
