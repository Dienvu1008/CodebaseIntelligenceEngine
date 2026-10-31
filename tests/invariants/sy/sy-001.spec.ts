// SY-001: SymbolId is a pure function of (language, modulePath, qualifiedName, kind, disambiguator) (ADR-0014).
// Identical content and producer version yield identical ids; body edits and in-file moves do not change
// them; renames and file moves do. The `~n` disambiguator appears only on collisions and follows
// declaration order. Every id parses back into exactly the parts it was built from. Only SymbolIdentity
// constructs SymbolIds (type-level check).
import {
  createFileExtraction,
  encodeNameSegment,
  identifySymbols,
  parseSymbolId,
  validateNameSegment,
  SYMBOL_KINDS,
  type CanonicalPath,
  type LanguageId,
  type SymbolDeclaration,
  type SymbolId,
} from '@cie/core';
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { extractionInput, hashOf, range, symbol, unwrap } from '../../helpers/extraction.js';

const TS = 'ts' as LanguageId;
const path = (p: string) => p as CanonicalPath;
const ids = (decls: readonly SymbolDeclaration[], p = 'src/a.ts', lang = TS) => unwrap(identifySymbols(lang, path(p), decls));

// Weighted towards a small pool of names and kinds, so collisions (and therefore ~n) are frequent.
const segment = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom('a', 'parse', 'default') },
  { weight: 1, arbitrary: fc.stringMatching(/^[A-Za-z_$][A-Za-z0-9_$]{0,6}$/) },
  { weight: 1, arbitrary: fc.constantFrom('café', '名前', 'Ünïcode', '<anon@1>', '<anon@2>', '__init__', 'π') },
);
const kind = fc.oneof({ weight: 3, arbitrary: fc.constantFrom('function' as const, 'method' as const) }, { weight: 1, arbitrary: fc.constantFrom(...SYMBOL_KINDS) });
const declaration = fc.record({ path: fc.array(segment, { minLength: 1, maxLength: 2 }), kind });
const declarations = fc.array(declaration, { maxLength: 25 });
const modulePath = fc.constantFrom('src/a.ts', 'src/auth/session.ts', 'pkg/__init__.py', 'a b/c#d.ts', 'dir.v2/x.tsx');

describe('SY-001: format (ADR-0014)', () => {
  it('matches the ADR example', () => {
    const [cls, method] = ids([{ path: ['SessionStore'], kind: 'class' }, { path: ['SessionStore', 'refresh'], kind: 'method' }], 'src/auth/session.ts');
    expect(cls).toBe('ts:src/auth/session.ts#SessionStore(class)');
    expect(method).toBe('ts:src/auth/session.ts#SessionStore.refresh(method)');
  });

  it('adds ~n only to colliding (qualifiedName, kind) triples, in declaration order', () => {
    const out = ids([
      { path: ['parse'], kind: 'function' },
      { path: ['parse'], kind: 'function' },
      { path: ['parse'], kind: 'variable' }, // same name, other kind: no collision
      { path: ['other'], kind: 'function' },
      { path: ['parse'], kind: 'function' },
    ]);
    expect(out).toEqual([
      'ts:src/a.ts#parse(function)~1',
      'ts:src/a.ts#parse(function)~2',
      'ts:src/a.ts#parse(variable)',
      'ts:src/a.ts#other(function)',
      'ts:src/a.ts#parse(function)~3',
    ]);
  });

  it('accepts default exports and <anon@n> placeholders, and rejects names that would make ids ambiguous', () => {
    expect(ids([{ path: ['default'], kind: 'function' }, { path: ['<anon@1>'], kind: 'class' }])).toEqual([
      'ts:src/a.ts#default(function)',
      'ts:src/a.ts#<anon@1>(class)',
    ]);
    for (const bad of ['', 'a.b', 'a#b', 'f(x)', 'a~1', 'a b', 'tab\t', '<computed>', '\ud800', '50%', '%2', '%zz', '%2e']) {
      const r = identifySymbols(TS, path('src/a.ts'), [{ path: [bad], kind: 'function' }]);
      expect(r.ok ? 'accepted' : r.error.code, JSON.stringify(bad)).toBe('SYMBOL_NAME_INVALID');
    }
  });

  it('encodes any source name into a valid segment, injectively', () => {
    expect(encodeNameSegment('#items')).toBe('%23items');
    expect(encodeNameSegment('[Symbol.iterator]')).toBe('[Symbol%2Eiterator]');
    expect(encodeNameSegment('q r')).toBe('q%20r');
    expect(encodeNameSegment('a\u3000b')).toBe('a%u3000b');
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 12, unit: 'binary' }), fc.string({ minLength: 1, maxLength: 12, unit: 'binary' }), (a, b) => {
        expect(validateNameSegment(encodeNameSegment(a)).ok).toBe(true);
        if (a !== b) expect(encodeNameSegment(a)).not.toBe(encodeNameSegment(b));
      }),
    );
  });

  it('rejects malformed or non-canonical ids when parsing', () => {
    for (const bad of ['', 'ts', 'ts:src/a.ts', 'ts:src/a.ts#f', 'ts:src/a.ts#f(nope)', 'TS:src/a.ts#f(function)', 'ts:/abs.ts#f(function)', 'ts:src/a.ts#f(function)~0', 'ts:src/a.ts#a..b(function)', 'ts:#f(function)']) {
      expect(parseSymbolId(bad).ok, bad).toBe(false);
    }
  });
});

describe('SY-001: determinism (property-based)', () => {
  it('is a pure function: same inputs give the same ids, and ids are unique within a module', () => {
    fc.assert(
      fc.property(modulePath, declarations, (p, decls) => {
        const a = ids(decls, p);
        expect(ids(structuredClone(decls), p)).toEqual(a);
        expect(new Set(a).size).toBe(a.length);
      }),
    );
  });

  it('round-trips: every id parses back into exactly the parts it was built from', () => {
    fc.assert(
      fc.property(modulePath, declarations, (p, decls) => {
        const out = ids(decls, p);
        const keys = decls.map((d) => `${d.path.join('.')}|${d.kind}`);
        out.forEach((id, i) => {
          const parsed = unwrap(parseSymbolId(id));
          const d = decls[i] as SymbolDeclaration;
          expect(parsed.id).toBe(id);
          expect({ language: parsed.language, modulePath: parsed.modulePath, qualifiedName: parsed.qualifiedName, kind: parsed.kind }).toEqual({
            language: 'ts',
            modulePath: p,
            qualifiedName: d.path.join('.'),
            kind: d.kind,
          });
          const colliding = keys.filter((k) => k === keys[i]).length > 1;
          const ordinal = keys.slice(0, i + 1).filter((k) => k === keys[i]).length;
          expect(parsed.disambiguator).toBe(colliding ? ordinal : null);
        });
      }),
    );
  });

  it('does not depend on unrelated declarations: adding a non-colliding declaration leaves existing ids unchanged', () => {
    fc.assert(
      fc.property(declarations, declaration, fc.nat(), (decls, extra, at) => {
        const key = (d: SymbolDeclaration) => `${d.path.join('.')}|${d.kind}`;
        fc.pre(!decls.some((d) => key(d) === key(extra)));
        const i = at % (decls.length + 1);
        const withExtra = [...decls.slice(0, i), extra, ...decls.slice(i)];
        const after = ids(withExtra);
        expect([...after.slice(0, i), ...after.slice(i + 1)]).toEqual(ids(decls));
      }),
    );
  });
});

describe('SY-001: stability through FileExtraction', () => {
  const source = (shift: number, body: string) =>
    extractionInput({
      symbols: [
        symbol('SessionStore', 'class', range(shift, 0, shift + 10, 1), null, { exported: true }),
        symbol('refresh', 'method', range(shift + 2, 2, shift + 5, 3), 0, { spanHash: hashOf(body), bodyFingerprint: hashOf(`fp:${body}`) }),
        symbol('refresh', 'method', range(shift + 6, 2, shift + 9, 3), 0), // overload / redeclaration
      ],
    });

  it('keeps ids under body edits and in-file moves (ranges, span hashes and fingerprints change)', () => {
    const a = unwrap(createFileExtraction(source(0, 'return 1')));
    const b = unwrap(createFileExtraction(source(40, 'return 2 + 2')));
    expect(b.symbols.map((s) => s.id)).toEqual(a.symbols.map((s) => s.id));
    expect(a.symbols.map((s) => s.id)).toEqual([
      'ts:src/a.ts#SessionStore(class)',
      'ts:src/a.ts#SessionStore.refresh(method)~1',
      'ts:src/a.ts#SessionStore.refresh(method)~2',
    ]);
    expect(a.symbols[1]?.parent).toBe(a.symbols[0]?.id);
    expect(a.symbols[1]?.qualifiedName).toBe('SessionStore.refresh');
  });

  it('changes ids on a rename or a file move (handled by lineage, SY-004)', () => {
    const renamed = ids([{ path: ['SessionCache'], kind: 'class' }]);
    const moved = ids([{ path: ['SessionStore'], kind: 'class' }], 'src/b.ts');
    expect(renamed).toEqual(['ts:src/a.ts#SessionCache(class)']);
    expect(moved).toEqual(['ts:src/b.ts#SessionStore(class)']);
  });
});

describe('SY-001: type-level', () => {
  it('a plain string is not a SymbolId', () => {
    const take = (id: SymbolId) => id;
    // @ts-expect-error a SymbolId can only come from SymbolIdentity (identifySymbols / parseSymbolId)
    take('ts:src/a.ts#f(function)');
    expectTypeOf<string>().not.toMatchTypeOf<SymbolId>();
  });
});
