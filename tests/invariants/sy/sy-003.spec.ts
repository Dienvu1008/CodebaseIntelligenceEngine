// SY-003: verifiable location. For every extracted symbol:
//  (a) its range lies within the bounds of the file content;
//  (b) spanHash = sha256(utf8(text(file, range))), with text decoded per CODE_INTELLIGENCE_STRATEGY §6.1
//      (BOM excluded; LSP line terminators \r\n, \n, \r; UTF-16 columns).
// The oracle below decodes and splits lines on its own (no SourceText), so a bug in the shared position
// mapping cannot hide itself. The validator form (spanViolations) must also catch tampered records.
import { createHash } from 'node:crypto';
import { NodeHasher, TreeSitterExtractor } from '@cie/adapters';
import { SourceText, spanViolations, type CanonicalPath, type FileExtraction, type LanguageId, type SourceRange } from '@cie/core';
import fc from 'fast-check';
import { beforeAll, describe, expect, it } from 'vitest';

const hasher = new NodeHasher();
let extractor: TreeSitterExtractor;
beforeAll(async () => {
  const x = await TreeSitterExtractor.create();
  if (!x.ok) throw new Error(x.error.message);
  extractor = x.value;
});

async function extract(path: string, language: string, bytes: Uint8Array): Promise<FileExtraction> {
  const r = await extractor.extractFile(
    { path: path as CanonicalPath, language: language as LanguageId, content: bytes, contentHash: hasher.sha256(bytes) },
    new AbortController().signal,
  );
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

/** Independent oracle: decode (BOM-aware), split into lines with their terminators, slice by line/column. */
function oracleDecode(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  const skip = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes.subarray(skip));
}
function oracleLines(text: string): { content: string; full: string }[] {
  const out: { content: string; full: string }[] = [];
  const re = /([^\r\n]*)(\r\n|\n|\r|$)/gy;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    out.push({ content: m[1] ?? '', full: m[0] });
    if (m[2] === '') break;
  }
  return out;
}
function oracleSlice(text: string, r: SourceRange): string | null {
  const lines = oracleLines(text);
  const start = lines[r.startLine];
  const end = lines[r.endLine];
  if (start === undefined || end === undefined || r.startCol > start.content.length || r.endCol > end.content.length) return null;
  if (r.startLine === r.endLine) return start.content.slice(r.startCol, r.endCol);
  const middle = lines.slice(r.startLine + 1, r.endLine).map((l) => l.full).join('');
  return start.full.slice(r.startCol) + middle + end.content.slice(0, r.endCol);
}
const sha = (s: string) => `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

function expectVerifiable(bytes: Uint8Array, e: FileExtraction): void {
  const text = oracleDecode(bytes);
  expect(e.symbols.length).toBeGreaterThan(0);
  for (const s of e.symbols) {
    const span = oracleSlice(text, s.range);
    expect(span, `${s.id} out of bounds`).not.toBeNull();
    expect(s.spanHash, s.id).toBe(sha(span as string));
  }
  expect(spanViolations(new SourceText(text), e.symbols, hasher)).toEqual([]);
}

const utf8 = (s: string) => new TextEncoder().encode(s);
const utf16le = (s: string) => {
  const out = new Uint8Array(2 + s.length * 2);
  out.set([0xff, 0xfe]);
  for (let i = 0; i < s.length; i++) {
    out[2 + i * 2] = s.charCodeAt(i) & 0xff;
    out[3 + i * 2] = s.charCodeAt(i) >> 8;
  }
  return out;
};

const TS_SAMPLE = [
  '// 😀 emoji (surrogate pair) and é before code shift UTF-16 columns',
  "export const sm = '😀😀';",
  '\tclass Tabbed {',
  '  /** a é b */ method😀() { return "x" }',
  '}',
  'function last() {}',
];
const PY_SAMPLE = ['# -*- coding: utf-8 -*-', 'class Café:', '    def naïve(self):', "        return '😀'", '', 'def tail():', '    pass'];

describe('SY-003: extracted ranges are in bounds and span hashes match (oracle)', () => {
  const cases: [string, string, string, Uint8Array][] = [
    ['TS, LF', 'src/a.ts', 'ts', utf8(TS_SAMPLE.join('\n'))],
    ['TS, CRLF', 'src/a.ts', 'ts', utf8(TS_SAMPLE.join('\r\n'))],
    ['TS, lone CR', 'src/a.ts', 'ts', utf8(TS_SAMPLE.join('\r'))],
    ['TS, UTF-8 BOM', 'src/a.ts', 'ts', utf8(`\ufeff${TS_SAMPLE.join('\n')}`)],
    ['TS, UTF-16LE BOM', 'src/a.ts', 'ts', utf16le(TS_SAMPLE.join('\r\n'))],
    ['TSX', 'src/b.tsx', 'tsx', utf8('export function B() {\r\n  return <i>😀</i>;\r\n}\r\n')],
    ['JS', 'lib/c.js', 'js', utf8('class A {\n  #p = "é";\n  m() {}\n}\nexport default class {}\n')],
    ['Python, LF', 'pkg/m.py', 'py', utf8(PY_SAMPLE.join('\n'))],
    ['Python, CRLF + BOM', 'pkg/m.py', 'py', utf8(`\ufeff${PY_SAMPLE.join('\r\n')}`)],
  ];
  for (const [label, path, language, bytes] of cases) {
    it(label, async () => expectVerifiable(bytes, await extract(path, language, bytes)));
  }

  it('the BOM never counts towards columns', async () => {
    const plain = await extract('src/a.ts', 'ts', utf8(TS_SAMPLE.join('\n')));
    const bom = await extract('src/a.ts', 'ts', utf8(`\ufeff${TS_SAMPLE.join('\n')}`));
    expect(bom.symbols.map((s) => [s.id, s.range, s.spanHash])).toEqual(plain.symbols.map((s) => [s.id, s.range, s.spanHash]));
  });

  it('holds for generated programs with mixed line terminators and non-ASCII names (property-based)', async () => {
    const name = fc.constantFrom('a', 'b2', 'café', 'π', '名前', '$x', '_y');
    const eol = fc.constantFrom('\n', '\r\n', '\r');
    const decl = fc.record({ name, eol, pad: fc.constantFrom('', ' ', '\t', '/*😀*/'), body: fc.constantFrom('', 'return 1;', "const s = '😀';") });
    await fc.assert(
      fc.asyncProperty(fc.array(decl, { minLength: 1, maxLength: 8 }), async (decls) => {
        const src = decls.map((d) => `${d.pad}function ${d.name}() {${d.eol}  ${d.body}${d.eol}}${d.eol}`).join('');
        const bytes = utf8(src);
        expectVerifiable(bytes, await extract('src/gen.ts', 'ts', bytes));
      }),
      { numRuns: 60 },
    );
  });
});

describe('SY-003: the validator catches tampered records', () => {
  it('flags a shifted range, a wrong hash and an out-of-bounds range; sampling still checks every bound', async () => {
    const bytes = utf8(TS_SAMPLE.join('\n'));
    const e = await extract('src/a.ts', 'ts', bytes);
    const text = new SourceText(oracleDecode(bytes));
    const [first, second, ...rest] = e.symbols;
    if (first === undefined || second === undefined) throw new Error('expected symbols');
    const shifted = { ...first, range: { ...first.range, startCol: first.range.startCol + 1 } };
    const wrongHash = { ...second, spanHash: hasher.sha256Text('nope') };
    const outside = { ...first, id: 'outside', range: { startLine: 0, startCol: 0, endLine: 99, endCol: 0 } };
    const v = spanViolations(text, [shifted, wrongHash, outside, ...rest], hasher);
    expect(v).toHaveLength(3);
    expect(v.filter((m) => m.includes('outside the file'))).toHaveLength(1);
    // With sample = 1 only record 0 is rehashed, but bounds are checked for all records.
    expect(spanViolations(text, [first, wrongHash, outside], hasher, 1)).toEqual([expect.stringContaining('outside the file')]);
  });
});
