// SY-006: precision is not overstated. An edge is `exact` only if the producer's fidelity for that edge's
// capability is L3 (`heuristic` needs L2); constructs the producer cannot resolve become edges to an
// explicit `unresolved` placeholder, never a guessed target. Covers dynamic `import(expr)`,
// `require(variable)` and Python `importlib.import_module(name)`. Also: a producer cannot emit facts for a
// capability it declares as L0 (FileExtraction factory).
import {
  createFileExtraction,
  createImportEdge,
  FIDELITIES,
  importEdgeViolations,
  type CanonicalPath,
  type Fidelity,
  type FileExtraction,
  type ImportResolution,
  type ImportTarget,
  type LanguageId,
  type Precision,
  type SymbolId,
} from '@cie/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { expressionImport, extraction, extractionInput, hasher, literalImport, producer, profile, range, symbol, unwrap } from '../../helpers/extraction.js';

const TS = 'ts' as LanguageId;
const JS = 'js' as LanguageId;
const PY = 'py' as LanguageId;
const moduleTarget = (p: string, language = TS): ImportTarget => ({ kind: 'module', language, path: p as CanonicalPath });
const resolver = (language: LanguageId, imports: Fidelity, adapterId = 'lang-ts') => ({ producer: producer(adapterId, '0.1.0', 'typescript@6.0.3'), profile: profile(language, 'L1', { imports }) });
const resolution = (target: ImportTarget, precision: Precision | null, extra: Partial<ImportResolution> = {}): ImportResolution => ({
  type: 'imports',
  importIndex: 0,
  name: null,
  target,
  precision,
  ...extra,
});
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);

describe('SY-006: the FileExtraction factory refuses facts for capabilities declared L0', () => {
  it.each([
    ['symbols', { symbols: [symbol('f', 'function', range(0, 0, 1, 1))] }],
    ['imports', { imports: [literalImport('./x', range(0, 0, 0, 20))] }],
    ['docstrings', { symbols: [symbol('f', 'function', range(0, 0, 1, 1), null, { doc: 'Does f.' })] }],
  ] as const)('%s', (capability, facts) => {
    const r = createFileExtraction(extractionInput({ profile: profile(TS, 'L1', { [capability]: 'L0' }), ...facts }));
    expect(code(r)).toBe('SY_006_CAPABILITY_NOT_DECLARED');
  });

  it('attaches the declared fidelity to every fact (SY-005 attribution)', () => {
    const e = extraction({
      profile: profile(PY, 'L1', { imports: 'L2' }),
      language: PY,
      path: 'pkg/mod.py',
      symbols: [symbol('f', 'function', range(0, 0, 1, 1))],
      imports: [literalImport('os', range(0, 0, 0, 9))],
    });
    expect(e.symbols[0]?.producer).toEqual({ adapterId: 'treesitter', adapterVersion: '0.1.0', toolVersion: 'web-tree-sitter@0.27.1', fidelity: 'L1' });
    expect(e.imports[0]?.producer.fidelity).toBe('L2');
  });

  it('rejects a profile for another language', () => {
    expect(code(createFileExtraction(extractionInput({ language: TS, profile: profile(PY, 'L1') })))).toBe('CAPABILITY_LANGUAGE_MISMATCH');
  });
});

describe('SY-006: precision follows fidelity', () => {
  const e = extraction({ imports: [literalImport('./b', range(0, 0, 0, 22))] });

  it('L3 may emit exact (verified); L2 at most heuristic (inferred); L1 and L0 cannot resolve imports', () => {
    const exact = unwrap(createImportEdge(e, resolution(moduleTarget('src/b.ts'), 'exact'), resolver(TS, 'L3'), hasher));
    expect([exact.precision, exact.status, exact.producer.fidelity, exact.to]).toEqual(['exact', 'verified', 'L3', 'mod:ts:src/b.ts']);
    const heuristic = unwrap(createImportEdge(e, resolution(moduleTarget('src/b.ts'), 'heuristic'), resolver(TS, 'L2'), hasher));
    expect([heuristic.precision, heuristic.status]).toEqual(['heuristic', 'inferred']);

    expect(code(createImportEdge(e, resolution(moduleTarget('src/b.ts'), 'exact'), resolver(TS, 'L2'), hasher))).toBe('SY_006_PRECISION_OVERSTATED');
    expect(code(createImportEdge(e, resolution(moduleTarget('src/b.ts'), 'heuristic'), resolver(TS, 'L1', 'treesitter'), hasher))).toBe('SY_006_PRECISION_OVERSTATED');
    expect(code(createImportEdge(e, resolution(moduleTarget('src/b.ts'), 'exact'), resolver(TS, 'L0'), hasher))).toBe('SY_006_CAPABILITY_NOT_DECLARED');
    expect(code(createImportEdge(e, resolution(moduleTarget('src/b.ts'), null), resolver(TS, 'L3'), hasher))).toBe('EDGE_PRECISION_REQUIRED');
  });

  it('never creates an edge that the validator form would flag (property-based)', () => {
    const target = fc.constantFrom<ImportTarget>(moduleTarget('src/b.ts'), { kind: 'external', ecosystem: 'npm', name: 'zod' }, { kind: 'unresolved' });
    fc.assert(
      fc.property(fc.constantFrom(...FIDELITIES), fc.constantFrom<Precision | null>('exact', 'heuristic', null), target, (fidelity, precision, t) => {
        const r = createImportEdge(e, resolution(t, precision), resolver(TS, fidelity), hasher);
        if (!r.ok) return;
        expect(importEdgeViolations(r.value)).toEqual([]);
        if (r.value.precision === 'exact') expect(fidelity).toBe('L3');
        if (r.value.precision === 'heuristic') expect(fidelity === 'L2' || fidelity === 'L3').toBe(true);
      }),
    );
  });

  it('the validator form flags stored edges whose precision exceeds the recorded fidelity', () => {
    const edge = unwrap(createImportEdge(e, resolution(moduleTarget('src/b.ts'), 'heuristic'), resolver(TS, 'L2'), hasher));
    expect(importEdgeViolations({ ...edge, precision: 'exact', status: 'verified' })).toHaveLength(1);
    expect(importEdgeViolations({ ...edge, producer: { ...edge.producer, fidelity: 'L1' } })).toHaveLength(1);
    expect(importEdgeViolations({ ...edge, status: 'verified' })).toHaveLength(1);
  });
});

describe('SY-006: unresolvable constructs target an unresolved placeholder, never a guess', () => {
  const cases: readonly [string, LanguageId, string, string][] = [
    ['dynamic import(expr)', TS, 'src/plugins.ts', 'import(`./plugins/${name}`)'],
    ['require(variable)', JS, 'lib/load.js', 'require(moduleName)'],
    ['importlib.import_module(name)', PY, 'pkg/loader.py', 'importlib.import_module(name)'],
  ];

  for (const [label, language, file, text] of cases) {
    it(label, () => {
      const e: FileExtraction = extraction({ language, path: file, profile: profile(language, 'L1'), imports: [expressionImport(text, range(3, 4, 3, 4 + text.length))] });
      // Even an L3 resolver may not point a non-literal specifier at a concrete module.
      const guess = createImportEdge(e, resolution(moduleTarget('src/plugins/a.ts', language), 'exact'), resolver(language, 'L3'), hasher);
      expect(code(guess)).toBe('SY_006_GUESSED_TARGET');

      const edge = unwrap(createImportEdge(e, resolution({ kind: 'unresolved' }, null), resolver(language, 'L3'), hasher));
      expect(edge.to).toMatch(new RegExp(`^unres:${language}:${file.replace('.', '\\.')}#[0-9a-f]{16}$`));
      expect([edge.toKind, edge.status, edge.precision, edge.attrs.raw, edge.attrs.isDynamic]).toEqual(['unresolved', 'unknown', null, text, true]);
      expect(importEdgeViolations(edge)).toEqual([]);
      // Deterministic: the same site always maps to the same placeholder.
      expect(unwrap(createImportEdge(e, resolution({ kind: 'unresolved' }, null), resolver(language, 'L3'), hasher)).to).toBe(edge.to);
    });
  }

  it('gives distinct sites distinct placeholders, and refuses precision on a placeholder', () => {
    const e = extraction({ imports: [expressionImport('import(a)', range(1, 0, 1, 9)), expressionImport('import(a)', range(2, 0, 2, 9))] });
    const a = unwrap(createImportEdge(e, resolution({ kind: 'unresolved' }, null), resolver(TS, 'L3'), hasher));
    const b = unwrap(createImportEdge(e, resolution({ kind: 'unresolved' }, null, { importIndex: 1 }), resolver(TS, 'L3'), hasher));
    expect(a.to).not.toBe(b.to);
    expect(code(createImportEdge(e, resolution({ kind: 'unresolved' }, 'heuristic'), resolver(TS, 'L3'), hasher))).toBe('SY_006_PRECISION_ON_UNRESOLVED');
  });

  it('allows a literal dynamic import to resolve exactly', () => {
    const e = extraction({ imports: [literalImport('./lazy', range(0, 0, 0, 16), [], { isDynamic: true })] });
    const edge = unwrap(createImportEdge(e, resolution(moduleTarget('src/lazy.ts'), 'exact'), resolver(TS, 'L3'), hasher));
    expect([edge.status, edge.attrs.isDynamic]).toEqual(['verified', true]);
  });

  it('imports_symbol must cite a name the import actually binds, and target a symbol', () => {
    const e = extraction({ imports: [literalImport('./b', range(0, 0, 0, 30), ['parse'])] });
    const sym = { kind: 'symbol', id: 'ts:src/b.ts#parse(function)' as SymbolId } as const;
    expect(unwrap(createImportEdge(e, resolution(sym, 'exact', { type: 'imports_symbol', name: 'parse' }), resolver(TS, 'L3'), hasher)).to).toBe(sym.id);
    expect(code(createImportEdge(e, resolution(sym, 'exact', { type: 'imports_symbol', name: 'other' }), resolver(TS, 'L3'), hasher))).toBe('EDGE_EVIDENCE_MISSING');
    expect(code(createImportEdge(e, resolution(moduleTarget('src/b.ts'), 'exact', { type: 'imports_symbol', name: 'parse' }), resolver(TS, 'L3'), hasher))).toBe('EDGE_SIGNATURE_MISMATCH');
    expect(code(createImportEdge(e, resolution(sym, 'exact'), resolver(TS, 'L3'), hasher))).toBe('EDGE_SIGNATURE_MISMATCH');
    expect(code(createImportEdge(e, resolution(sym, 'exact', { importIndex: 5 }), resolver(TS, 'L3'), hasher))).toBe('EDGE_EVIDENCE_MISSING');
  });
});
