// SY-003: verifiable location. For every extracted symbol:
//  (a) its range lies within the bounds of the file content;
//  (b) spanHash = sha256(utf8(text(file, range))), with text decoded per CODE_INTELLIGENCE_STRATEGY §6.1
//      (BOM excluded; LSP line terminators \r\n, \n, \r; UTF-16 columns).
// The oracle below decodes and splits lines on its own (no SourceText), so a bug in the shared position
// mapping cannot hide itself. The validator form (spanViolations) must also catch tampered records.
//
// At publish (Phase 03, P03-02) the RevisionValidator enforces SY-003 on the stored rows: bounds for every
// symbol from the stored file line counts, and span hashes for a deterministic sample re-read from disk
// (all of them in these tests). A tampered range or span hash aborts the publish.
import { createHash } from 'node:crypto';
import path from 'node:path';
import { NodeHasher, TreeSitterExtractor, type OpenedIndexStore } from '@cie/adapters';
import Database from 'better-sqlite3';
import {
  createFileExtraction,
  decodeForSpanCheck,
  LanguageRegistry,
  MVP_LANGUAGES,
  ok,
  runFullIndex,
  SourceText,
  spanViolations,
  verifySpans,
  type CanonicalPath,
  type CodeGraph,
  type CodeNode,
  type FileExtraction,
  type FileExtractor,
  type JobId,
  type LanguageId,
  type ManifestEntry,
  type RevisionSeq,
  type SourceRange,
} from '@cie/core';
import fc from 'fast-check';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { codeGraphOf } from '../../helpers/code-graph.js';
import { extractionInput, range, symbol } from '../../helpers/extraction.js';
import { cseq, digestAt, EMPTY_GRAPH, job, publishRevision, sandbox, stageAll, type Sandbox } from '../../helpers/index-store.js';
import { memoryFs } from '../../helpers/workspace-fixture.js';

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

  it('the publish-time decoder sees the same text as the extractors', () => {
    const utf16be = (s: string) => {
      const le = utf16le(s);
      const out = new Uint8Array(le.length);
      for (let i = 0; i < le.length; i += 2) [out[i], out[i + 1]] = [le[i + 1] as number, le[i] as number];
      return out;
    };
    const long = 'x😀\r\n'.repeat(3000); // crosses the decoder's chunk size
    for (const bytes of [...cases.map((c) => c[3]), utf16be(TS_SAMPLE.join('\n')), utf16le(long), utf8(`\ufeff${long}`)]) {
      expect(decodeForSpanCheck(bytes)).toBe(oracleDecode(bytes));
    }
    expect(decodeForSpanCheck(new Uint8Array([0xff, 0xfe, 0x41]))).toBeNull(); // odd UTF-16 length
  });

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

describe('SY-003: extractions end on an existing line', () => {
  it('the factory refuses a range past the last line and an invalid line count', () => {
    const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);
    expect(code(createFileExtraction(extractionInput({ lineCount: 2, symbols: [symbol('f', 'function', range(0, 0, 1, 1))] })))).toBe('ok');
    expect(code(createFileExtraction(extractionInput({ lineCount: 2, symbols: [symbol('f', 'function', range(0, 0, 2, 0))] })))).toBe('SY_003_OUT_OF_BOUNDS');
    expect(code(createFileExtraction(extractionInput({ lineCount: 0 })))).toBe('EXTRACTION_LINE_COUNT_INVALID');
  });

  it('extractors report the decoded line count', async () => {
    expect((await extract('src/a.ts', 'ts', utf8('a\r\nb\rc\n'))).lineCount).toBe(4);
    expect((await extract('src/a.ts', 'ts', utf8('\ufefffunction f() {}'))).lineCount).toBe(1);
  });
});

const FILES = {
  'src/a.ts': "import { b } from './b';\nexport function a() {\n  return b;\n}\n",
  'src/b.ts': '// é 😀\r\nexport const b = 1;\r\nexport class B {\r\n  m() {}\r\n}\r\n',
};

describe('SY-003 at publish: the RevisionValidator on stored rows', () => {
  let sb: Sandbox;
  let o: OpenedIndexStore;
  beforeEach(async () => {
    sb = await sandbox();
    o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
  });
  afterEach(() => sb.dispose());

  const fs = memoryFs(FILES);
  const spans = (seq: RevisionSeq, sample: number | null, files = fs) =>
    verifySpans({ store: o.store, fs: files, hasher, signal: new AbortController().signal }, seq, sample);

  /** Stages a revision on top of the head and marks it validating; returns its seq. */
  async function staged(manifest: readonly ManifestEntry[], graph: CodeGraph): Promise<RevisionSeq> {
    const head = await o.store.head();
    const rev = await o.store.begin(head?.seq ?? null, job(`j-${Math.random()}`));
    if (!rev.ok) throw new Error(rev.error.code);
    await stageAll(o, rev.value.seq, manifest, graph);
    const v = await o.store.markValidating(rev.value.seq);
    if (!v.ok) throw new Error(v.error.code);
    return rev.value.seq;
  }

  const symbols = (g: CodeGraph) => g.nodes.filter((n) => n.kind === 'symbol');
  function tamper(g: CodeGraph, id: string, change: (s: NonNullable<CodeNode['symbol']>) => NonNullable<CodeNode['symbol']>): CodeGraph {
    if (!g.nodes.some((n) => n.id === id && n.symbol !== null)) throw new Error(`no symbol ${id}`);
    return { ...g, nodes: g.nodes.map((n) => (n.id === id && n.symbol !== null ? { ...n, symbol: change(n.symbol) } : n)) };
  }

  it('an untampered revision validates, every stored span rehashes, and it publishes', async () => {
    const { manifest, graph } = await codeGraphOf(FILES);
    expect(graph.files.map((f) => [f.path, f.lineCount])).toEqual([
      ['src/a.ts', 5],
      ['src/b.ts', 6],
    ]);
    const seq = await staged(manifest, graph);
    expect(await o.store.validate(seq)).toEqual([]);
    const r = await spans(seq, null);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value).toEqual({ total: symbols(graph).length, checked: symbols(graph).length, unverifiable: 0, violations: [] });
    expect((await o.store.publish(seq, cseq(0))).ok).toBe(true);
  });

  it('a stored range past the end of its file aborts publish (bounds are checked for every symbol)', async () => {
    const { manifest, graph } = await codeGraphOf(FILES);
    const id = 'ts:src/b.ts#B.m(method)';
    const seq = await staged(manifest, tamper(graph, id, (s) => ({ ...s, range: { ...s.range, endLine: 6 } })));
    const violations = await o.store.validate(seq);
    expect(violations).toEqual([expect.stringMatching(new RegExp(`^SY-003: symbol ${id.replace(/[.()]/g, '\\$&')} range .* outside its file \\(6 line`))]);
    const published = await o.store.publish(seq, cseq(0));
    expect(published.ok === false && published.error.code).toBe('PUBLISH_VALIDATION_FAILED');
    expect(await o.store.head()).toBeNull();
  });

  it('a stored span hash or an in-bounds shifted range that does not match the text is caught by the rehash', async () => {
    const { manifest, graph } = await codeGraphOf(FILES);
    const g1 = tamper(graph, 'ts:src/a.ts#a(function)', (s) => ({ ...s, spanHash: hasher.sha256Text('function a() {}') }));
    const g2 = tamper(g1, 'ts:src/b.ts#B(class)', (s) => ({ ...s, range: { ...s.range, startCol: s.range.startCol + 1 } }));
    const seq = await staged(manifest, g2);
    expect(await o.store.validate(seq)).toEqual([]); // in bounds: only the content can tell
    const r = await spans(seq, null);
    if (!r.ok) throw new Error(r.error.code);
    expect(r.value.violations).toEqual([
      'SY-003: ts:src/a.ts#a(function) spanHash does not match the text in its range',
      'SY-003: ts:src/b.ts#B(class) spanHash does not match the text in its range',
    ]);
  });

  it('samples every k-th stored symbol in id order, deterministically', async () => {
    const { manifest, graph } = await codeGraphOf(FILES);
    const seq = await staged(manifest, graph);
    // Node ids are ASCII here, so SQLite's byte order and the JS code-unit order agree.
    const ids = symbols(graph).map((n) => n.id).sort();
    const sampled = async (n: number | null) => {
      const r = await o.store.sampleSpans(seq, n);
      if (!r.ok) throw new Error(r.error.code);
      return r.value;
    };
    expect(await sampled(1)).toMatchObject({ total: ids.length, records: [expect.objectContaining({ id: ids[0] })] });
    const step = Math.ceil(ids.length / 2);
    expect((await sampled(2)).records.map((r) => r.id)).toEqual(ids.filter((_, i) => i % step === 0));
    expect(await sampled(2)).toEqual(await sampled(2));
    expect((await sampled(null)).records.map((r) => r.id)).toEqual(ids);
    expect((await sampled(ids.length + 5)).records).toHaveLength(ids.length);
  });

  it('a file that changed after enumeration is unverifiable, not a violation', async () => {
    const { manifest, graph } = await codeGraphOf(FILES);
    const seq = await staged(manifest, graph);
    const r = await spans(seq, null, memoryFs({ ...FILES, 'src/b.ts': `${FILES['src/b.ts']}// edited\n` }));
    if (!r.ok) throw new Error(r.error.code);
    const inB = symbols(graph).filter((n) => n.file === 'src/b.ts').length;
    expect(r.value).toMatchObject({ unverifiable: inB, checked: symbols(graph).length - inB, violations: [] });
  });

  it('staging refuses file facts for content other than the manifest version', async () => {
    const { manifest, graph } = await codeGraphOf(FILES);
    const rev = await o.store.begin(null, job('j1'));
    if (!rev.ok) throw new Error(rev.error.code);
    await o.store.stageManifest(rev.value.seq, manifest);
    await o.store.stageStructure(rev.value.seq, []);
    const other = hasher.sha256Text('other');
    const bad = { ...graph, files: graph.files.map((f) => (f.path === 'src/a.ts' ? { ...f, contentHash: other } : f)) };
    const r = await o.store.stageGraph(rev.value.seq, bad);
    expect(r.ok === false && r.error.code).toBe('SY_003_CONTENT_MISMATCH');
    expect((await o.store.stageGraph(rev.value.seq, graph)).ok).toBe(true); // rolled back: retry works
  });

  it('a published file version without a line count is re-versioned, never updated in place (SN-007)', async () => {
    const { manifest, graph } = await codeGraphOf(FILES);
    const s1 = await publishRevision(o, manifest, 0, EMPTY_GRAPH); // structure only: no line counts stored
    const before = await digestAt(o, s1);
    const s2 = await publishRevision(o, manifest, 0, graph);
    expect(await digestAt(o, s1)).toBe(before);
    const raw = new Database(path.join(sb.stateDir, 'index.db'), { readonly: true });
    const rows = raw
      .prepare('select k.path, f.line_count as lines, f.valid_from_seq as vf, f.valid_to_seq as vt from file f join file_key k on k.key = f.file_key order by f.id')
      .all();
    raw.close();
    expect(rows).toEqual([
      { path: 'src/a.ts', lines: null, vf: s1, vt: s2 },
      { path: 'src/b.ts', lines: null, vf: s1, vt: s2 },
      { path: 'src/a.ts', lines: 5, vf: s2, vt: null },
      { path: 'src/b.ts', lines: 6, vf: s2, vt: null },
    ]);
    // A third revision with the same content carries the completed rows unchanged.
    const rev = await o.store.begin(s2, job('j3'));
    if (!rev.ok) throw new Error(rev.error.code);
    const stats = await o.store.stageManifest(rev.value.seq, manifest);
    expect(stats.ok && stats.value).toEqual({ inserted: 0, closed: 0, unchanged: 2 });
  });
});

describe('SY-003 at publish: the index pipeline', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox();
  });
  afterEach(() => sb.dispose());

  const encoder = new TextEncoder();
  const manifest: ManifestEntry[] = Object.entries(FILES).map(([p, text]) => {
    const bytes = encoder.encode(text);
    return { path: p as CanonicalPath, status: 'indexed', hash: hasher.sha256(bytes), size: bytes.length, language: 'ts' };
  });

  /** The real extractor, optionally corrupting the extraction it returns (an adapter bug SY-003 must catch). */
  function registry(corrupt?: (e: FileExtraction) => FileExtraction): LanguageRegistry {
    const wrapped: FileExtractor = {
      producer: extractor.producer,
      profiles: extractor.profiles,
      extractFile: async (input, signal) => {
        const r = await extractor.extractFile(input, signal);
        return r.ok && corrupt !== undefined ? ok(corrupt(r.value)) : r;
      },
    };
    const r = LanguageRegistry.create({ languages: MVP_LANGUAGES, extractors: [wrapped], resolvers: [] });
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  }

  async function index(corrupt?: (e: FileExtraction) => FileExtraction) {
    const o = await sb.open();
    const signal = new AbortController().signal;
    const outcome = await runFullIndex({
      store: o.store,
      lease: o.store.lease,
      holder: 'writer-1',
      leaseTtlMs: 60_000,
      jobId: 'job-1' as JobId,
      hasher,
      signal,
      enumerate: async () => ok({ entries: manifest, unrepresentable: [], unlistable: [], ignored: 0 }),
      code: { registry: registry(corrupt), fs: memoryFs(FILES) },
      spanSample: null,
    });
    return { o, outcome };
  }

  it('publishes a correct extraction after rehashing every span', async () => {
    const { o, outcome } = await index();
    if (!outcome.ok) throw new Error(`${outcome.error.code}: ${JSON.stringify(outcome.error.details)}`);
    expect(outcome.value.spans.total).toBeGreaterThan(0);
    expect(outcome.value.spans).toEqual({ total: outcome.value.spans.total, checked: outcome.value.spans.total, unverifiable: 0 });
    expect((await o.store.head())?.seq).toBe(outcome.value.seq);
  });

  it('aborts the publish when an extractor reports a span hash that does not match its range', async () => {
    const { o, outcome } = await index((e) => (e.path === 'src/b.ts' ? ({ ...e, symbols: e.symbols.map((s, i) => (i === 0 ? { ...s, spanHash: hasher.sha256Text('x') } : s)) } as FileExtraction) : e));
    expect(outcome.ok === false && outcome.error.code).toBe('PUBLISH_VALIDATION_FAILED');
    const details = outcome.ok ? [] : (outcome.error.details as { violations: string[] }).violations;
    expect(details).toEqual([expect.stringMatching(/^SY-003: ts:src\/b\.ts#.* spanHash does not match/)]);
    expect(await o.store.head()).toBeNull();
  });
});
