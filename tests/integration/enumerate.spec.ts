// Enumeration on a real tree through GuardedFileSystem (P01-09): ignore layers, size limit, binary
// detection, symlinks, unrepresentable names, and determinism.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GuardedFileSystem, NodeHasher } from '@cie/adapters';
import { DEFAULT_WORKSPACE_SETTINGS, enumerateWorkspace, type EnumerationResult, type WorkspaceSettings } from '@cie/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkDir, tryLinkFile } from '../helpers/links.js';

let dir: string;
let ws: string;
let fileLink = false;
const nonPortableSupported = process.platform !== 'win32';

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cie-enum-'));
  ws = path.join(dir, 'ws');
  const w = (rel: string, content: string | Uint8Array) => {
    const abs = path.join(ws, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  w('.gitignore', 'build/\n*.log\n');
  w('src/a.ts', 'export const a = 1;\n');
  w('src/b.py', 'x = 1\n');
  w('src/readme.md', '# hi\n');
  w('src/.gitignore', '!keep.log\n');
  w('src/keep.log', 'kept\n');
  w('app.log', 'ignored\n');
  w('build/out.js', 'ignored\n');
  w('node_modules/dep/index.js', 'ignored by CIE defaults\n');
  w('gen/x.ts', 'ignored by cie.config.json\n');
  w('big.ts', 'x'.repeat(2048));
  w('image.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  mkdirSync(path.join(dir, 'outside'), { recursive: true });
  writeFileSync(path.join(dir, 'outside', 'secret.ts'), 'secret');
  linkDir(path.join(dir, 'outside'), path.join(ws, 'escape'));
  linkDir(path.join(ws, 'src'), path.join(ws, 'src-alias'));
  fileLink = tryLinkFile(path.join(ws, 'src', 'a.ts'), path.join(ws, 'a-link.ts'));
  if (nonPortableSupported) w('weird/aux.c', 'int main;\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const settings: WorkspaceSettings = { ...DEFAULT_WORKSPACE_SETTINGS, ignore: ['gen/'], maxFileBytes: 1024 };

async function run(): Promise<EnumerationResult> {
  const r = await enumerateWorkspace({ fs: await GuardedFileSystem.open(ws), hasher: new NodeHasher(), settings, signal: new AbortController().signal });
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
}

describe('enumeration', () => {
  it('applies every ignore layer and classifies what remains', async () => {
    const r = await run();
    const byPath = new Map(r.entries.map((e) => [e.path as string, e]));
    expect([...byPath.keys()].filter((p) => !p.startsWith('weird/')).sort()).toEqual(
      ['.gitignore', 'big.ts', 'escape', 'image.png', 'src-alias', 'src/.gitignore', 'src/a.ts', 'src/b.py', 'src/keep.log', 'src/readme.md', ...(fileLink ? ['a-link.ts'] : [])].sort(),
    );
    expect(byPath.get('src/a.ts')).toMatchObject({ status: 'indexed', language: 'ts', size: 20 });
    expect(byPath.get('src/b.py')).toMatchObject({ status: 'indexed', language: 'py' });
    expect(byPath.get('src/readme.md')).toMatchObject({ status: 'indexed', language: null });
    expect(byPath.get('big.ts')).toMatchObject({ status: 'skipped', reason: 'too_large', size: 2048 });
    expect(byPath.get('image.png')).toMatchObject({ status: 'skipped', reason: 'binary' });
    expect(byPath.get('escape')).toMatchObject({ status: 'skipped', reason: 'symlink_escape', size: 0 });
    expect(byPath.get('src-alias')).toMatchObject({ status: 'skipped', reason: 'symlink', size: 0 });
    if (fileLink) expect(byPath.get('a-link.ts')).toMatchObject({ status: 'skipped', reason: 'symlink' });
    expect(r.ignored).toBeGreaterThanOrEqual(4); // app.log, build/, node_modules/, gen/
  });

  it.skipIf(!nonPortableSupported)('reports names that cannot be canonical paths instead of indexing them', async () => {
    const r = await run();
    expect(r.entries.some((e) => e.path.startsWith('weird/'))).toBe(false);
    expect(r.unrepresentable).toEqual([{ parent: 'weird', name: 'aux.c', code: 'PATH_NON_PORTABLE' }]);
  });

  it('is deterministic', async () => {
    expect(await run()).toEqual(await run());
  });

  it('honours cancellation', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await enumerateWorkspace({ fs: await GuardedFileSystem.open(ws), hasher: new NodeHasher(), settings, signal: ac.signal });
    expect(r.ok === false && r.error.code).toBe('CANCELLED');
  });
});
