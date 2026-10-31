// P02-04 golden: the LanguageRegistry is the authority on file languages, and the Phase 01 extension map
// (`languageForPath`, used by enumeration to fill ManifestEntry.language) must agree with it on every path.
// The workspace context cannot import code-intelligence (DEPENDENCY_RULES C5), so the two tables are kept
// in step by this test instead of by an import. Changing either side without the other fails here.
import { canonicalizePath, LanguageRegistry, languageForPath, MVP_LANGUAGES, type CanonicalPath } from '@cie/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { unwrap } from '../helpers/extraction.js';

const registry = unwrap(LanguageRegistry.create({ languages: MVP_LANGUAGES, extractors: [], resolvers: [] }));
const cp = (p: string): CanonicalPath => unwrap(canonicalizePath(p));

describe('LanguageRegistry agrees with the Phase 01 extension map', () => {
  it('pins the MVP extension table', () => {
    const table = Object.fromEntries(registry.languages().map((d) => [d.id, [...d.extensions]]));
    expect(table).toEqual({ js: ['js', 'mjs', 'cjs', 'jsx'], py: ['py', 'pyi'], ts: ['ts', 'mts', 'cts'], tsx: ['tsx'] });
  });

  it('agrees on every registered extension and on the edge cases', () => {
    const paths = [
      ...MVP_LANGUAGES.flatMap((d) => d.extensions.flatMap((e) => [`a.${e}`, `dir/sub/a.b.${e}`, `x.${e}.bak`, `.${e}`, `a.${e.toUpperCase()}`])),
      'a.d.ts',
      'Makefile',
      'dir.ts/file',
      'dir.py/README',
      'x.json',
      'x.pyc',
      'x.pyw',
      'x.tsbuildinfo',
      'x.vue',
      'café.py',
      '名前.ts',
    ];
    for (const p of paths) {
      const path = cp(p);
      expect(registry.languageForPath(path), p).toBe(languageForPath(path));
    }
  });

  it('agrees on arbitrary file names (property-based)', () => {
    const segment = fc.stringMatching(/^[A-Za-z0-9_.-]{1,12}$/).filter((s) => canonicalizePath(s).ok);
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 3 }), (segments) => {
        const r = canonicalizePath(segments.join('/'));
        fc.pre(r.ok);
        if (!r.ok) return;
        expect(registry.languageForPath(r.value)).toBe(languageForPath(r.value));
      }),
    );
  });
});
