// WS-002: paths are canonical and confined to the root.
// This file covers part (a), the lexical canonicalization in PathCanonicalizer, on every OS. Parts (b)
// realpath confinement and (c) symlink escapes are added to this file with GuardedFileSystem (P01-06).
import { canonicalizePath, type PathErrorCode } from '@cie/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

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
