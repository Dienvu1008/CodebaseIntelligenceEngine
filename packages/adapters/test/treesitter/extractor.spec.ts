// TreeSitterExtractor (P02-05): CIE-owned queries → symbols, kinds, imports, docs, diagnostics and
// fingerprints for TS, TSX, JS and Python. Spans are covered by SY-003; this file pins extraction semantics.
import { NodeHasher, TreeSitterExtractor } from '@cie/adapters';
import type { CanonicalPath, FileExtraction, LanguageId } from '@cie/core';
import { beforeAll, describe, expect, it } from 'vitest';

const hasher = new NodeHasher();
let x: TreeSitterExtractor;
beforeAll(async () => {
  const r = await TreeSitterExtractor.create();
  if (!r.ok) throw new Error(r.error.message);
  x = r.value;
});

const utf8 = (s: string) => new TextEncoder().encode(s);
async function run(path: string, language: string, src: string | Uint8Array, signal = new AbortController().signal) {
  const bytes = typeof src === 'string' ? utf8(src) : src;
  return x.extractFile({ path: path as CanonicalPath, language: language as LanguageId, content: bytes, contentHash: hasher.sha256(bytes) }, signal);
}
async function extract(path: string, language: string, src: string): Promise<FileExtraction> {
  const r = await run(path, language, src);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
const ids = (e: FileExtraction) => e.symbols.map((s) => s.id);
const symbolNamed = (e: FileExtraction, qn: string) => e.symbols.find((s) => s.qualifiedName === qn);

const TS = `/** Session cache. */
export class SessionStore {
  #items = [];
  get size() { return 1 }
  set size(v) {}
  constructor() {}
  [Symbol.iterator]() {}
  "q r"() {}
  refresh(): void {}
}
export default function () {}
function f(a: string): void;
function f(a) {}
export const g = () => 1, h = class {};
let v = 1;
const k = 2;
enum E { A, B = 2 }
interface I { m(): void; p: number }
type Alias = 1;
abstract class Q { abstract k(): void }
`;

describe('TypeScript', () => {
  it('extracts declarations with refined kinds, nesting, encoded names and overload disambiguators', async () => {
    const e = await extract('src/a.ts', 'ts', TS);
    expect(ids(e)).toEqual([
      'ts:src/a.ts#SessionStore(class)',
      'ts:src/a.ts#SessionStore.%23items(property)',
      'ts:src/a.ts#SessionStore.size(getter)',
      'ts:src/a.ts#SessionStore.size(setter)',
      'ts:src/a.ts#SessionStore.constructor(constructor)',
      'ts:src/a.ts#SessionStore.[Symbol%2Eiterator](method)',
      'ts:src/a.ts#SessionStore.q%20r(method)',
      'ts:src/a.ts#SessionStore.refresh(method)',
      'ts:src/a.ts#default(function)',
      'ts:src/a.ts#f(function)~1',
      'ts:src/a.ts#f(function)~2',
      'ts:src/a.ts#g(function)',
      'ts:src/a.ts#h(class)',
      'ts:src/a.ts#v(variable)',
      'ts:src/a.ts#k(constant)',
      'ts:src/a.ts#E(enum)',
      'ts:src/a.ts#E.A(enum_member)',
      'ts:src/a.ts#E.B(enum_member)',
      'ts:src/a.ts#I(interface)',
      'ts:src/a.ts#I.m(method)',
      'ts:src/a.ts#I.p(property)',
      'ts:src/a.ts#Alias(type)',
      'ts:src/a.ts#Q(class)',
      'ts:src/a.ts#Q.k(method)',
    ]);
    expect(e.symbols.filter((s) => s.exported).map((s) => s.qualifiedName)).toEqual(['SessionStore', 'default', 'g', 'h']);
    expect(symbolNamed(e, 'SessionStore')?.doc).toBe('Session cache.');
    expect(e.diagnostics).toEqual([]);
  });

  it('extracts static, type-only, re-export, dynamic and require imports; non-literal specifiers stay expressions', async () => {
    const e = await extract(
      'src/i.ts',
      'ts',
      `import type { T } from './t';\nimport d, { u as v2, "s" as s2 } from "./u";\nimport * as ns from 'ns';\nexport * from './all';\nexport { a as b } from './ab';\nconst r = require(mod); const r2 = require('lit');\nimport("./lazy"); import(\`./\${p}\`);\nimport fs = require('fs');\n`,
    );
    expect(e.imports.map((i) => [i.specifier, i.isDynamic, i.isTypeOnly, i.names])).toEqual([
      [{ kind: 'literal', value: './t' }, false, true, ['T']],
      [{ kind: 'literal', value: './u' }, false, false, ['default', 'u', 's']],
      [{ kind: 'literal', value: 'ns' }, false, false, []],
      [{ kind: 'literal', value: './all' }, false, false, []],
      [{ kind: 'literal', value: './ab' }, false, false, ['a']],
      [{ kind: 'expression', text: 'mod' }, true, false, []],
      [{ kind: 'literal', value: 'lit' }, false, false, []],
      [{ kind: 'literal', value: './lazy' }, true, false, []],
      [{ kind: 'expression', text: '`./${p}`' }, true, false, []],
      [{ kind: 'literal', value: 'fs' }, false, false, []],
    ]);
  });

  it('matches the TypeScript compiler on class overloads, parameter properties, namespaces, declare global and object literals', async () => {
    const e = await extract(
      'src/p.ts',
      'ts',
      [
        'export class S {',
        '  static create(): S;',
        '  static create(x?: number): S { return new S(1) }',
        '  constructor(private readonly deps: string, readonly r: number, public p?: string, override o = 1, plain: number) {}',
        '  m() { const o = { inner() {}, get g() { return 1 } }; return o }',
        '}',
        'declare global { var gc: () => void; }',
        'export namespace util { export const a = 1; const b = 2; export function f() {} }',
        'const literal = { m() {}, get g() { return 1 } };',
        '',
      ].join('\n'),
    );
    expect(ids(e)).toEqual([
      'ts:src/p.ts#S(class)',
      'ts:src/p.ts#S.create(method)~1',
      'ts:src/p.ts#S.create(method)~2',
      'ts:src/p.ts#S.constructor(constructor)',
      'ts:src/p.ts#S.deps(property)',
      'ts:src/p.ts#S.r(property)',
      'ts:src/p.ts#S.p(property)',
      'ts:src/p.ts#S.o(property)',
      'ts:src/p.ts#S.m(method)',
      'ts:src/p.ts#global(namespace)',
      'ts:src/p.ts#global.gc(variable)',
      'ts:src/p.ts#util(namespace)',
      'ts:src/p.ts#util.a(constant)',
      'ts:src/p.ts#util.b(constant)',
      'ts:src/p.ts#util.f(function)',
      'ts:src/p.ts#literal(constant)',
    ]);
    expect(e.symbols.filter((s) => s.qualifiedName.startsWith('util.')).map((s) => [s.name, s.exported])).toEqual([
      ['a', true],
      ['b', false],
      ['f', true],
    ]);
  });

  it('flags the default export, and ignores type-literal members of parameters', async () => {
    const e = await extract(
      'src/d.ts',
      'ts',
      'export default function shout(s: string) { return s }\nexport function card({ user }: { user: string }) {}\ntype Shape = { area: number; scale(k: number): void };\ninterface I { p: string }\n',
    );
    expect(e.symbols.map((s) => [s.qualifiedName, s.defaultExport])).toEqual([
      ['shout', true],
      ['card', false],
      ['Shape', false],
      ['Shape.area', false],
      ['Shape.scale', false],
      ['I', false],
      ['I.p', false],
    ]);
  });

  it('records the producer per language with L1 attribution', async () => {
    const e = await extract('src/a.ts', 'ts', 'function a() {}');
    expect(e.producer).toEqual({ adapterId: 'treesitter', adapterVersion: '0.1.0', toolVersion: 'web-tree-sitter@0.27.1+tree-sitter-typescript@0.23.2' });
    expect(e.symbols[0]?.producer.fidelity).toBe('L1');
    expect(x.profiles.map((p) => [p.language, p.fidelity.symbols, p.fidelity.imports, p.fidelity.references])).toEqual([
      ['ts', 'L1', 'L1', 'L0'],
      ['tsx', 'L1', 'L1', 'L0'],
      ['js', 'L1', 'L1', 'L0'],
      // P03-08: Python reports free-name uses (syntax for lang-python's L2 references), declared as L1.
      ['py', 'L1', 'L1', 'L1'],
    ]);
  });
});

describe('Python free-name occurrences (P03-08)', () => {
  it('reports uses of free names only: not declarations, attributes, keywords, imports or function locals', async () => {
    const src = [
      'import os',
      'from m import helper',
      'LIMIT = 3',
      'def f(a, b=LIMIT, *rest, **kw):',
      '    c = helper(a, key=os.sep)',
      '    for i in rest: c += i',
      '    return [x for x in kw if x] or g(c)',
      'class K(Base):',
      '    size = LIMIT',
      '    def m(self): return self.size',
    ].join('\n');
    const e = await extract('pkg/mod.py', 'py', src);
    expect(e.occurrences.map((o) => `${o.name}@${o.range.startLine}${o.call ? ' call' : ''}`)).toEqual([
      'LIMIT@3', // default value: evaluated in the enclosing (module) scope
      'helper@4 call',
      'os@4', // `os.sep` reports the object, not the attribute
      'g@6 call',
      'Base@7',
      'LIMIT@8',
    ]);
  });

  it('honours global, nonlocal, walrus, with/except targets and nested functions', async () => {
    const src = [
      'def f():',
      '    global G',
      '    G = G + 1',
      '    with open(p) as fh: pass',
      '    if (n := size()): pass',
      '    def inner():',
      '        nonlocal n',
      '        return n + G + fh',
      '    return inner()',
    ].join('\n');
    const e = await extract('pkg/mod.py', 'py', src);
    expect(e.occurrences.map((o) => `${o.name}@${o.range.startLine}${o.call ? ' call' : ''}`)).toEqual(['G@2', 'open@3 call', 'p@3', 'size@4 call', 'G@7']);
  });

  it('reports nothing for TypeScript and JavaScript (lang-ts binds through the TypeChecker)', async () => {
    expect((await extract('src/a.ts', 'ts', 'const a = 1;\nexport const b = a + c;\n')).occurrences).toEqual([]);
  });
});

describe('TSX and JavaScript', () => {
  it('parses JSX and JS class fields, including private names and anonymous default classes', async () => {
    expect(ids(await extract('src/b.tsx', 'tsx', 'export function Button() { return <b>{1}</b>; }\n'))).toEqual(['tsx:src/b.tsx#Button(function)']);
    const js = await extract('lib/c.js', 'js', "class A { #p = 1; static s = 2; m() {} }\nconst { x } = require('./x');\nconst y = require('./y');\nexport default class {}\n");
    expect(ids(js)).toEqual(['js:lib/c.js#A(class)', 'js:lib/c.js#A.%23p(property)', 'js:lib/c.js#A.s(property)', 'js:lib/c.js#A.m(method)', 'js:lib/c.js#default(class)']);
    // `const y = require('./y')` is an import binding, not a symbol; a destructured require binds its keys.
    expect(js.imports.map((i) => [i.specifier, i.names])).toEqual([
      [{ kind: 'literal', value: './x' }, ['x']],
      [{ kind: 'literal', value: './y' }, []],
    ]);
    const renamed = await extract('lib/r.js', 'js', "const { a, b: c, 'q r': d, ...rest } = require('./m');\n");
    expect(renamed.imports[0]?.names).toEqual(['a', 'b', 'q r']);
  });
});

describe('Python', () => {
  const PY = `"""Module."""
import os, a.b as c
from .x import (y, z as w)
from . import q
from m import *
import importlib
mod = importlib.import_module(name)
lit = importlib.import_module("pkg.lit")
_private = 1

@dec
class P(B):
    """Doc of P."""
    X = 1
    def __init__(self):
        def inner(): pass
    async def h(self): ...

def top():
    "d"
`;

  it('extracts classes, methods, constructors, properties and module variables with docstrings', async () => {
    const e = await extract('pkg/m.py', 'py', PY);
    expect(ids(e)).toEqual([
      'py:pkg/m.py#mod(variable)',
      'py:pkg/m.py#lit(variable)',
      'py:pkg/m.py#_private(variable)',
      'py:pkg/m.py#P(class)',
      'py:pkg/m.py#P.X(property)',
      'py:pkg/m.py#P.__init__(constructor)',
      'py:pkg/m.py#P.__init__.inner(function)',
      'py:pkg/m.py#P.h(method)',
      'py:pkg/m.py#top(function)',
    ]);
    expect(e.symbols.filter((s) => s.exported).map((s) => s.qualifiedName)).toEqual(['mod', 'lit', 'P', 'top']);
    expect([symbolNamed(e, 'P')?.doc, symbolNamed(e, 'top')?.doc]).toEqual(['Doc of P.', 'd']);
    // The class range starts at `class`, not at the decorator.
    expect(symbolNamed(e, 'P')?.range.startLine).toBe(11);
  });

  it('extracts plain, from, relative and importlib imports', async () => {
    const e = await extract('pkg/m.py', 'py', PY);
    expect(e.imports.map((i) => [i.specifier, i.isDynamic, i.names])).toEqual([
      [{ kind: 'literal', value: 'os' }, false, []],
      [{ kind: 'literal', value: 'a.b' }, false, []],
      [{ kind: 'literal', value: '.x' }, false, ['y', 'z']],
      [{ kind: 'literal', value: '.' }, false, ['q']],
      [{ kind: 'literal', value: 'm' }, false, []],
      [{ kind: 'literal', value: 'importlib' }, false, []],
      [{ kind: 'expression', text: 'name' }, true, []],
      [{ kind: 'literal', value: 'pkg.lit' }, true, []],
    ]);
  });
});

describe('parse errors, fingerprints and failures', () => {
  it('drops declarations inside ERROR regions, keeps the rest and reports diagnostics', async () => {
    const e = await extract('src/e.ts', 'ts', 'function good() {}\nclass { broken ( \nfunction after() {}\n');
    expect(e.diagnostics.length).toBeGreaterThan(0);
    expect(e.diagnostics.every((d) => d.code === 'PARSE_ERROR' || d.code === 'PARSE_MISSING')).toBe(true);
    expect(ids(e)).toContain('ts:src/e.ts#good(function)');
    // Error recovery can surface a member with no class around it; such orphans are not symbols.
    const orphan = await extract('src/o.ts', 'ts', 'export function before() {}\n\nclass {\n  broken( ;\n}\n\nexport function after() {}\n');
    expect(orphan.symbols.filter((s) => s.parent === null).map((s) => s.kind)).not.toContain('property');
  });

  it('keeps the well-formed declarations when error recovery turns the root into an ERROR node', async () => {
    // An unclosed block at the end of a file (a file being edited) makes tree-sitter return an ERROR root;
    // so does `using` as an identifier on CodeForge-v2 (tree-sitter-typescript 0.23.2), found by the P02-13
    // quality report. The well-formed declarations before the error must survive.
    const src = "import { x } from './x';\nfunction files(e: number): number {\n  return e;\n}\nexport const after = 1;\ndescribe('suite', () => {\n  it('case', () => {\n";
    const e = await extract('src/u.ts', 'ts', src);
    expect(ids(e)).toEqual(['ts:src/u.ts#files(function)', 'ts:src/u.ts#after(constant)']);
    expect(e.imports.map((i) => i.specifier)).toEqual([{ kind: 'literal', value: './x' }]);
    expect(e.diagnostics.length).toBeGreaterThan(0);
    // The diagnostics point at the actual errors, not at the whole file.
    expect(e.diagnostics.every((d) => d.range === null || d.range.startLine > 0)).toBe(true);
  });

  it('is deterministic, and CRLF vs LF changes span hashes but neither ids nor fingerprints', async () => {
    const lf = await extract('src/a.ts', 'ts', TS);
    expect(await extract('src/a.ts', 'ts', TS)).toEqual(lf);
    const crlf = await extract('src/a.ts', 'ts', TS.replace(/\n/g, '\r\n'));
    expect(ids(crlf)).toEqual(ids(lf));
    expect(crlf.symbols.map((s) => s.bodyFingerprint)).toEqual(lf.symbols.map((s) => s.bodyFingerprint));
    expect(symbolNamed(crlf, 'SessionStore')?.spanHash).not.toBe(symbolNamed(lf, 'SessionStore')?.spanHash);
  });

  it('bodyFingerprint ignores the own name, comments and whitespace, and changes with the body', async () => {
    const fp = async (src: string) => (await extract('src/f.ts', 'ts', src)).symbols[0]?.bodyFingerprint;
    const base = await fp('function a(x) { return x + 1 }');
    expect(await fp('function renamed(x) { return x + 1 }')).toBe(base);
    expect(await fp('function a(x) {\n  // note\n  return   x + 1\n}')).toBe(base);
    expect(await fp('function a(x) { return x + 2 }')).not.toBe(base);
  });

  it('fails explicitly on undecodable bytes, unsupported languages and cancellation', async () => {
    const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);
    expect(code(await run('src/a.ts', 'ts', new Uint8Array([0x66, 0xff, 0xfe, 0x00, 0xc3])))).toBe('EXTRACTION_UNDECODABLE');
    expect(code(await run('lib/a.dart', 'dart', 'void main() {}'))).toBe('EXTRACTION_UNSUPPORTED_LANGUAGE');
    const aborted = new AbortController();
    aborted.abort();
    expect(code(await run('src/a.ts', 'ts', 'function a() {}', aborted.signal))).toBe('EXTRACTION_CANCELLED');
  });
});
