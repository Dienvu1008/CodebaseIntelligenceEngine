// WS-002: paths are canonical and confined to the root.
//  (a) lexical canonicalization in PathCanonicalizer, identical on every OS;
//  (b) realpath confinement and (c) symlink/junction escapes, enforced by GuardedFileSystem.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { GuardedFileSystem } from '@cie/adapters';
import { canonicalizePath, type CanonicalPath, type PathErrorCode } from '@cie/core';
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkDir, tryLinkFile } from '../../helpers/links.js';

const accepted: Array<[raw: string, canonical: string]> = [
  ['src/a.ts', 'src/a.ts'],
  ['src\\a.ts', 'src/a.ts'],
  ['./src//a.ts', 'src/a.ts'],
  ['src/./x/../a.ts', 'src/a.ts'],
  ['src/a.ts/', 'src/a.ts'],
  ['e\u0301.ts', '\u00e9.ts'], // NFD becomes NFC
  ['Src/A.TS', 'Src/A.TS'], // case is preserved
  ['console.ts', 'console.ts'], // only exact device names are reserved
  ['..foo/.bar', '..foo/.bar'], // dot-prefixed names are fine
];

const rejected: Array<[raw: string, code: PathErrorCode]> = [
  ['', 'PATH_EMPTY'],
  ['.', 'PATH_EMPTY'],
  ['./', 'PATH_EMPTY'],
  ['a/..', 'PATH_EMPTY'],
  ['/etc/passwd', 'PATH_ABSOLUTE'],
  ['\\\\server\\share\\x', 'PATH_ABSOLUTE'],
  ['\\\\?\\C:\\x', 'PATH_ABSOLUTE'],
  ['\\\\.\\pipe\\x', 'PATH_ABSOLUTE'],
  ['//x', 'PATH_ABSOLUTE'],
  ['C:\\x', 'PATH_ABSOLUTE'],
  ['c:/x', 'PATH_ABSOLUTE'],
  ['C:x', 'PATH_ABSOLUTE'],
  ['..', 'PATH_ESCAPES_ROOT'],
  ['../x', 'PATH_ESCAPES_ROOT'],
  ['..\\x', 'PATH_ESCAPES_ROOT'],
  ['a/../../x', 'PATH_ESCAPES_ROOT'],
  ['a\u0000b', 'PATH_INVALID_CHAR'],
  ['a\nb', 'PATH_INVALID_CHAR'],
  ['a\tb', 'PATH_INVALID_CHAR'],
  ['a\u007fb', 'PATH_INVALID_CHAR'],
  ['\ud800x', 'PATH_INVALID_CHAR'],
  ['x\udc00', 'PATH_INVALID_CHAR'],
  ['file.txt:stream', 'PATH_NON_PORTABLE'], // NTFS alternate data stream
  ['a/CON', 'PATH_NON_PORTABLE'],
  ['a/con.txt', 'PATH_NON_PORTABLE'],
  ['LPT1', 'PATH_NON_PORTABLE'],
  ['COM\u00b9', 'PATH_NON_PORTABLE'],
  ['a<b', 'PATH_NON_PORTABLE'],
  ['a?b', 'PATH_NON_PORTABLE'],
  ['a*b', 'PATH_NON_PORTABLE'],
  ['a"b', 'PATH_NON_PORTABLE'],
  ['a|b', 'PATH_NON_PORTABLE'],
  ['dir./x', 'PATH_NON_PORTABLE'],
  ['x ', 'PATH_NON_PORTABLE'],
];

describe('WS-002 (a): lexical canonicalization', () => {
  it.each(accepted)('accepts %j as %j', (raw, canonical) => {
    expect(canonicalizePath(raw)).toEqual({ ok: true, value: canonical });
  });

  it.each(rejected)('rejects %j with %s', (raw, code) => {
    const r = canonicalizePath(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
  });

  it('only ever produces canonical, root-confined output, and is idempotent (property)', () => {
    const pathChars = fc.constantFrom('a', 'B', '.', '/', '\\', ':', ' ', '\u00e9', 'e\u0301', '-', '_', '~', '\u0000');
    const rawPath = fc.oneof(fc.string(), fc.array(pathChars, { maxLength: 24 }).map((cs) => cs.join('')));
    fc.assert(
      fc.property(rawPath, (raw) => {
        const r = canonicalizePath(raw);
        if (!r.ok) return;
        const p: string = r.value;
        expect(p).not.toMatch(/\\|\/\/|^\//);
        expect(p.split('/').every((s) => s !== '' && s !== '.' && s !== '..')).toBe(true);
        expect(p).toBe(p.normalize('NFC'));
        expect(canonicalizePath(p)).toEqual({ ok: true, value: p });
      }),
      { seed: 20261031, numRuns: 2000 },
    );
  });
});

// ---------------------------------------------------------------------------------------------------
// WS-002 (b) realpath confinement and (c) symlink escapes, enforced by GuardedFileSystem.
// ---------------------------------------------------------------------------------------------------

const cp = (raw: string): CanonicalPath => {
  const r = canonicalizePath(raw);
  if (!r.ok) throw new Error(raw);
  return r.value;
};
const signal = new AbortController().signal;

describe('WS-002 (b, c): GuardedFileSystem confines reads to the real root', () => {
  let sandbox: string;
  let root: string;
  let fileLinkCreated = false;
  let fsys: GuardedFileSystem;

  beforeAll(async () => {
    sandbox = mkdtempSync(nodePath.join(tmpdir(), 'cie-ws002-'));
    root = nodePath.join(sandbox, 'workspace');
    const outside = nodePath.join(sandbox, 'outside');
    mkdirSync(nodePath.join(root, 'src', 'real'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(nodePath.join(root, 'src', 'real', 'a.ts'), 'export const a = 1;\n');
    writeFileSync(nodePath.join(outside, 'secret.txt'), 'SECRET');
    linkDir(outside, nodePath.join(root, 'escape-dir')); // escapes the root
    linkDir(nodePath.join(root, 'src', 'real'), nodePath.join(root, 'alias')); // stays inside
    fileLinkCreated = tryLinkFile(nodePath.join(outside, 'secret.txt'), nodePath.join(root, 'escape-file.txt'));
    // Open the workspace through a link to it: the root itself is resolved once, at open.
    linkDir(root, nodePath.join(sandbox, 'workspace-link'));
    fsys = await GuardedFileSystem.open(nodePath.join(sandbox, 'workspace-link'));
  });
  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  it('reads a regular file inside the root, even when the root was opened through a link', async () => {
    const r = await fsys.readFile(cp('src/real/a.ts'), signal);
    expect(r.ok && new TextDecoder().decode(r.value)).toBe('export const a = 1;\n');
  });

  it('classifies real paths as inside, outside or missing', async () => {
    expect(await fsys.realpath(cp('alias/a.ts'))).toEqual({ kind: 'inside', path: 'src/real/a.ts' });
    expect(await fsys.realpath(cp('escape-dir/secret.txt'))).toEqual({ kind: 'outside' });
    expect(await fsys.realpath(cp('escape-dir'))).toEqual({ kind: 'outside' });
    expect(await fsys.realpath(cp('nope/missing.ts'))).toEqual({ kind: 'missing' });
  });

  it('refuses to read or list through a directory link that escapes the root (c)', async () => {
    const read = await fsys.readFile(cp('escape-dir/secret.txt'), signal);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('FS_OUTSIDE_ROOT');
    const list = await fsys.list(cp('escape-dir'), signal);
    expect(list.ok).toBe(false);
    if (!list.ok) expect(list.error.code).toBe('FS_OUTSIDE_ROOT');
  });

  it('refuses to read through a file symlink that escapes the root (c)', async (ctx) => {
    if (!fileLinkCreated) {
      console.warn('[WS-002] file symlink not created (EPERM: no symlink privilege); case skipped on this machine');
      ctx.skip();
    }
    const read = await fsys.readFile(cp('escape-file.txt'), signal);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error.code).toBe('FS_OUTSIDE_ROOT');
  });

  it('reports links as symlinks without following them (lstat) and lists in code-unit order', async () => {
    expect((await fsys.stat(cp('escape-dir')))?.kind).toBe('symlink');
    const list = await fsys.list(null, signal);
    if (!list.ok) throw new Error(list.error.message);
    const names = list.value.map((e) => e.name);
    expect(names).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(list.value.find((e) => e.name === 'escape-dir')?.kind).toBe('symlink');
  });

  it('honours cancellation', async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await fsys.readFile(cp('src/real/a.ts'), ac.signal);
    expect(r.ok === false && r.error.code).toBe('FS_CANCELLED');
  });
});
