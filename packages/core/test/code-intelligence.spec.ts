// code-intelligence domain: capability profiles, producer identity and the FileExtraction factory's
// structural checks (ranges, source order, nesting). Identity and precision rules are covered by the
// invariant tests SY-001 and SY-006.
import {
  capabilityProfile,
  createFileExtraction,
  formatProducer,
  languageId,
  maxPrecision,
  precisionAllowed,
  producerIdentity,
  type LanguageId,
} from '@cie/core';
import { describe, expect, it } from 'vitest';
import { expressionImport, extractionInput, literalImport, range, symbol, unwrap } from '../../../tests/helpers/extraction.js';

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);
const TS = 'ts' as LanguageId;
const ALL_L1 = { symbols: 'L1', imports: 'L1', references: 'L1', calls: 'L1', typeRelations: 'L1', di: 'L1', docstrings: 'L1' };

describe('CapabilityProfile', () => {
  it('requires every capability to be declared with a valid fidelity', () => {
    expect(code(capabilityProfile(TS, ALL_L1))).toBe('ok');
    const { di: _di, ...missing } = ALL_L1;
    expect(code(capabilityProfile(TS, missing))).toBe('CAPABILITY_FIDELITY_INVALID');
    expect(code(capabilityProfile(TS, { ...ALL_L1, calls: 'L4' }))).toBe('CAPABILITY_FIDELITY_INVALID');
    expect(code(capabilityProfile(TS, { ...ALL_L1, telepathy: 'L3' }))).toBe('CAPABILITY_UNKNOWN');
  });

  it('maps fidelity to the maximum precision', () => {
    expect(['L0', 'L1', 'L2', 'L3'].map((f) => maxPrecision(f as 'L0'))).toEqual([null, null, 'heuristic', 'exact']);
    expect(precisionAllowed('heuristic', 'L3')).toBe(true);
    expect(precisionAllowed('exact', 'L2')).toBe(false);
    expect(precisionAllowed('heuristic', 'L1')).toBe(false);
  });

  it('validates language ids and producer identities', () => {
    expect(code(languageId('dart'))).toBe('ok');
    for (const bad of ['', 'TS', '1x', 'a b', 'x'.repeat(33)]) expect(code(languageId(bad)), bad).toBe('INVALID_LANGUAGE_ID');
    const p = unwrap(producerIdentity('lang-ts', '0.1.0', 'typescript@6.0.3'));
    expect(formatProducer(p)).toBe('lang-ts@0.1.0+typescript@6.0.3');
    expect(code(producerIdentity('lang ts', '0.1.0', 'x'))).toBe('PRODUCER_INVALID');
    expect(code(producerIdentity('lang-ts', '', 'x'))).toBe('PRODUCER_INVALID');
  });
});

describe('createFileExtraction structural checks', () => {
  const cls = symbol('A', 'class', range(0, 0, 10, 1));

  it('accepts nested declarations in source order and builds qualified names from parents', () => {
    const e = unwrap(
      createFileExtraction(
        extractionInput({
          symbols: [cls, symbol('m', 'method', range(1, 2, 3, 3), 0), symbol('inner', 'function', range(2, 4, 2, 20), 1), symbol('b', 'function', range(11, 0, 12, 1))],
        }),
      ),
    );
    expect(e.symbols.map((s) => s.qualifiedName)).toEqual(['A', 'A.m', 'A.m.inner', 'b']);
    expect(e.symbols.map((s) => s.parent)).toEqual([null, 'ts:src/a.ts#A(class)', 'ts:src/a.ts#A.m(method)', null]);
  });

  it('rejects out-of-order declarations, bad parents, children outside their parent and invalid ranges', () => {
    const run = (symbols: Parameters<typeof extractionInput>[0]) => code(createFileExtraction(extractionInput(symbols)));
    expect(run({ symbols: [symbol('b', 'function', range(5, 0, 6, 0)), symbol('a', 'function', range(1, 0, 2, 0))] })).toBe('EXTRACTION_ORDER');
    expect(run({ symbols: [cls, symbol('m', 'method', range(1, 0, 2, 0), 1)] })).toBe('EXTRACTION_PARENT_INVALID');
    expect(run({ symbols: [cls, symbol('m', 'method', range(1, 0, 2, 0), -1)] })).toBe('EXTRACTION_PARENT_INVALID');
    expect(run({ symbols: [cls, symbol('m', 'method', range(9, 0, 11, 0), 0)] })).toBe('EXTRACTION_PARENT_INVALID');
    expect(run({ symbols: [symbol('a', 'function', range(3, 0, 2, 0))] })).toBe('EXTRACTION_RANGE_INVALID');
    expect(run({ symbols: [symbol('a', 'function', range(0, -1, 2, 0))] })).toBe('EXTRACTION_RANGE_INVALID');
    expect(run({ symbols: [symbol('a.b', 'function', range(0, 0, 1, 0))] })).toBe('SYMBOL_NAME_INVALID');
  });

  it('rejects empty specifiers and names, and invalid diagnostic ranges', () => {
    const run = (o: Parameters<typeof extractionInput>[0]) => code(createFileExtraction(extractionInput(o)));
    expect(run({ imports: [literalImport('', range(0, 0, 0, 1))] })).toBe('EXTRACTION_IMPORT_INVALID');
    expect(run({ imports: [expressionImport('', range(0, 0, 0, 1))] })).toBe('EXTRACTION_IMPORT_INVALID');
    expect(run({ imports: [literalImport('./x', range(0, 0, 0, 1), [''])] })).toBe('EXTRACTION_IMPORT_INVALID');
    expect(run({ diagnostics: [{ code: 'PARSE_ERROR', message: 'x', range: range(2, 0, 1, 0) }] })).toBe('EXTRACTION_RANGE_INVALID');
    expect(run({ diagnostics: [{ code: 'PARSE_ERROR', message: 'x', range: null }] })).toBe('ok');
  });

  it('numbers imports and copies inputs, so later mutation of the drafts cannot change the extraction', () => {
    const names = ['a'];
    const e = unwrap(createFileExtraction(extractionInput({ imports: [literalImport('./x', range(0, 0, 0, 1), names), literalImport('./y', range(1, 0, 1, 1))] })));
    names.push('b');
    expect(e.imports.map((i) => [i.index, i.names])).toEqual([
      [0, ['a']],
      [1, []],
    ]);
  });
});
