// P02-12: hand-verified ground truth per golden fixture (fixtures/<name>.truth.json), compared with what the
// pipeline actually publishes (the committed export, which export-golden.spec.ts proves is current).
// The difference must be exactly the documented known gaps. It is a ratchet in both directions: a regression
// fails, and so does an improvement, so the list (and the quality report, P02-13) is updated deliberately.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { GOLDEN_FIXTURES } from '../helpers/golden.js';
import { repoPath } from '../helpers/repo.js';

interface Truth {
  format: string;
  fixture: string;
  notes: string[];
  symbols: string[];
  imports: string[];
  importsSymbol: string[];
}
interface ExportDoc {
  files: { path: string }[];
  nodes: { id: string; kind: string; name: string }[];
  edges: { type: string; from: string; to: string; attrs: Record<string, unknown> }[];
}
type Category = 'symbols' | 'imports' | 'importsSymbol';

/** Known gaps of the Phase 02 producers, by fixture: entries the ideal producer finds and CIE does not, or vice versa. */
const KNOWN_GAPS: Partial<Record<string, Partial<Record<Category, { missing?: string[]; extra?: string[] }>>>> = {
  // ts-basic: the TS parameter property gap was closed in P02-13.
  'js-mixed': { importsSymbol: { missing: ['mod:js:lib/server.js -> formatDate -> js:lib/dates.js#formatDate(function)'] } }, // destructured require (L1)
};

/** The same normalization the truth files use: unresolved targets are named by their raw specifier. */
function actual(doc: ExportDoc): Record<Category, string[]> {
  const nodes = new Map(doc.nodes.map((n) => [n.id, n]));
  const target = (to: string) => (to.startsWith('unres:') ? `unresolved:${nodes.get(to)?.name ?? '?'}` : to);
  return {
    symbols: doc.nodes.filter((n) => n.kind === 'symbol').map((n) => n.id),
    imports: doc.edges.filter((e) => e.type === 'imports').map((e) => `${e.from} -> ${target(e.to)}`),
    importsSymbol: doc.edges.filter((e) => e.type === 'imports_symbol').map((e) => `${e.from} -> ${String(e.attrs['name'])} -> ${target(e.to)}`),
  };
}

const sorted = (xs: readonly string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

for (const fixture of GOLDEN_FIXTURES) {
  describe(`ground truth: ${fixture}`, () => {
    const truth = JSON.parse(readFileSync(repoPath(`fixtures/${fixture}.truth.json`), 'utf8')) as Truth;
    const doc = JSON.parse(readFileSync(repoPath(`fixtures/${fixture}.export.json`), 'utf8')) as ExportDoc;

    it('is well-formed, reviewed and refers only to files of the fixture', () => {
      expect([truth.format, truth.fixture]).toEqual(['cie-truth/1', fixture]);
      expect(truth.notes.length, 'a truth file records how it was verified').toBeGreaterThan(0);
      const files = new Set(doc.files.map((f) => f.path));
      const pathOf = (id: string) => /^(?:mod:)?[a-z]+:(.+?)(?:#|$)/.exec(id)?.[1];
      for (const s of truth.symbols) expect(files.has(pathOf(s) ?? ''), s).toBe(true);
      for (const e of [...truth.imports, ...truth.importsSymbol]) expect(files.has(pathOf(e.split(' -> ')[0] ?? '') ?? ''), e).toBe(true);
      for (const c of ['symbols', 'imports', 'importsSymbol'] as const) expect(new Set(truth[c]).size, `${c} has duplicates`).toBe(truth[c].length);
    });

    for (const category of ['symbols', 'imports', 'importsSymbol'] as const) {
      it(`${category}: differs from the published graph exactly by the known gaps`, () => {
        const got = new Set(actual(doc)[category]);
        const want = new Set(truth[category]);
        const missing = sorted([...want].filter((x) => !got.has(x)));
        const extra = sorted([...got].filter((x) => !want.has(x)));
        const gaps = KNOWN_GAPS[fixture]?.[category];
        expect({ missing, extra }).toEqual({ missing: sorted(gaps?.missing ?? []), extra: sorted(gaps?.extra ?? []) });
      });
    }
  });
}
