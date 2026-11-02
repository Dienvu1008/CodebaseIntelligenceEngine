// SY-006: precision is not overstated. An edge is `exact` only if the producer's fidelity for that edge's
// capability is L3 (`heuristic` needs L2); constructs the producer cannot resolve become edges to an
// explicit `unresolved` placeholder, never a guessed target. Covers dynamic `import(expr)`,
// `require(variable)` and Python `importlib.import_module(name)`. Also: a producer cannot emit facts for a
// capability it declares as L0 (FileExtraction factory). Phase 03: the same rules for relation edges
// (references, calls, type relations), where dynamic calls go to unresolved placeholders; the end-to-end
// cases (handlers[name](), a call on an `any` value) are in the ts-relations golden fixture.
import {
  createFileExtraction,
  createImportEdge,
  createRelationEdge,
  FIDELITIES,
  importEdgeViolations,
  RELATION_CAPABILITY,
  RELATION_EDGE_TYPES,
  type RelationEdgeType,
  type RelationResolution,
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

describe('SY-006: relation edges (Phase 03, P03-07)', () => {
  const e = extraction({ lineCount: 20, symbols: [symbol('main', 'function', range(0, 0, 9, 1)), symbol('Base', 'class', range(10, 0, 12, 1))] });
  const [main, base] = e.symbols;
  if (main === undefined || base === undefined) throw new Error('fixture');
  const target = { kind: 'symbol', id: 'ts:src/b.ts#helper(function)' as SymbolId } as const;
  const rel = (type: RelationEdgeType, extra: Partial<RelationResolution> = {}): RelationResolution => ({
    type,
    from: main.id,
    target,
    range: range(3, 2, 3, 8),
    raw: 'helper',
    precision: 'exact',
    ...extra,
  });
  const relResolver = (fidelity: Fidelity, capability: string) => ({ producer: producer('lang-ts', '0.1.0', 'typescript@6.0.3'), profile: profile(TS, 'L1', { [capability]: fidelity }) });

  it('requires L3 of the capability behind each type for exact, L2 for heuristic, and refuses L0', () => {
    for (const type of RELATION_EDGE_TYPES) {
      const capability = RELATION_CAPABILITY[type];
      const from = type === 'extends' || type === 'implements' ? base.id : main.id;
      const exact = unwrap(createRelationEdge(e, rel(type, { from }), relResolver('L3', capability), hasher));
      expect([exact.status, exact.precision, exact.producer.fidelity, exact.toKind], type).toEqual(['verified', 'exact', 'L3', 'symbol']);
      expect(importEdgeViolations(exact)).toEqual([]);
      expect(code(createRelationEdge(e, rel(type, { from }), relResolver('L2', capability), hasher)), type).toBe('SY_006_PRECISION_OVERSTATED');
      expect(code(createRelationEdge(e, rel(type, { from, precision: 'heuristic' }), relResolver('L2', capability), hasher)), type).toBe('ok');
      expect(code(createRelationEdge(e, rel(type, { from }), relResolver('L0', capability), hasher)), type).toBe('SY_006_CAPABILITY_NOT_DECLARED');
      expect(code(createRelationEdge(e, rel(type, { from, precision: null }), relResolver('L3', capability), hasher)), type).toBe('EDGE_PRECISION_REQUIRED');
    }
  });

  it('only calls may target an unresolved placeholder: no precision, status unknown, one placeholder per site', () => {
    const r = relResolver('L3', 'calls');
    const dyn = unwrap(createRelationEdge(e, rel('calls', { target: { kind: 'unresolved' }, precision: null, raw: 'handlers[k]' }), r, hasher));
    expect([dyn.toKind, dyn.status, dyn.precision, dyn.attrs.raw]).toEqual(['unresolved', 'unknown', null, 'handlers[k]']);
    expect(dyn.to).toMatch(/^unres:ts:src\/a\.ts#[0-9a-f]{16}$/);
    expect(importEdgeViolations(dyn)).toEqual([]);
    const other = unwrap(createRelationEdge(e, rel('calls', { target: { kind: 'unresolved' }, precision: null, raw: 'handlers[k]', range: range(4, 2, 4, 13) }), r, hasher));
    expect(other.to).not.toBe(dyn.to);
    expect(code(createRelationEdge(e, rel('calls', { target: { kind: 'unresolved' }, precision: 'exact' }), r, hasher))).toBe('SY_006_PRECISION_ON_UNRESOLVED');
    for (const type of ['references', 'references_type', 'extends', 'implements'] as const) {
      expect(code(createRelationEdge(e, rel(type, { from: base.id, target: { kind: 'unresolved' }, precision: null }), relResolver('L3', RELATION_CAPABILITY[type]), hasher)), type).toBe('EDGE_SIGNATURE_MISMATCH');
    }
  });

  it('gives calls a per-site key and the aggregated types none; top-level code starts at the module, heritage never does', () => {
    const calls = unwrap(createRelationEdge(e, rel('calls'), relResolver('L3', 'calls'), hasher));
    const again = unwrap(createRelationEdge(e, rel('calls', { range: range(5, 0, 5, 6) }), relResolver('L3', 'calls'), hasher));
    expect(calls.site).toMatch(/^[0-9a-f]{16}$/);
    expect(again.site).not.toBe(calls.site);
    expect(unwrap(createRelationEdge(e, rel('references'), relResolver('L3', 'references'), hasher)).site).toBe('');
    expect(unwrap(createRelationEdge(e, rel('calls', { from: null }), relResolver('L3', 'calls'), hasher)).from).toBe('mod:ts:src/a.ts');
    expect(code(createRelationEdge(e, rel('extends', { from: null }), relResolver('L3', 'typeRelations'), hasher))).toBe('EDGE_SIGNATURE_MISMATCH');
    expect(code(createRelationEdge(e, rel('calls', { from: 'ts:src/other.ts#x(function)' as SymbolId }), relResolver('L3', 'calls'), hasher))).toBe('EDGE_SIGNATURE_MISMATCH');
    expect(code(createRelationEdge(e, rel('calls', { range: range(25, 0, 25, 3) }), relResolver('L3', 'calls'), hasher))).toBe('EDGE_EVIDENCE_INVALID');
  });

  it('never creates a relation edge that the validator form would flag (property-based)', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...RELATION_EDGE_TYPES),
        fc.constantFrom(...FIDELITIES),
        fc.constantFrom<Precision | null>('exact', 'heuristic', null),
        fc.boolean(),
        (type, fidelity, precision, unresolved) => {
          const res = rel(type, { from: base.id, precision, ...(unresolved ? { target: { kind: 'unresolved' } } : {}) });
          const r = createRelationEdge(e, res, relResolver(fidelity, RELATION_CAPABILITY[type]), hasher);
          if (!r.ok) return;
          expect(importEdgeViolations(r.value)).toEqual([]);
          if (r.value.precision === 'exact') expect(fidelity).toBe('L3');
        },
      ),
    );
  });
});
