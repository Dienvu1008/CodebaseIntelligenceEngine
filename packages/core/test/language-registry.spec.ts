// LanguageRegistry: validation of the registered set, resolver ordering, and the effective capability matrix.
import {
  LanguageRegistry,
  MVP_LANGUAGES,
  type CanonicalPath,
  type Fidelity,
  type FileExtractor,
  type LanguageId,
  type ProjectResolver,
} from '@cie/core';
import { describe, expect, it } from 'vitest';
import { producer, profile, unwrap } from '../../../tests/helpers/extraction.js';

const lang = (id: string) => id as LanguageId;
const notCalled = (): never => {
  throw new Error('not called in registry tests');
};

function extractor(adapterId: string, languages: readonly string[], base: Fidelity = 'L1', overrides: Partial<Record<string, Fidelity>> = {}): FileExtractor {
  return { producer: producer(adapterId), profiles: languages.map((l) => profile(lang(l), base, overrides)), extractFile: notCalled };
}

function resolver(adapterId: string, languages: readonly string[], imports: Fidelity, overrides: Partial<Record<string, Fidelity>> = {}): ProjectResolver {
  return { producer: producer(adapterId), profiles: languages.map((l) => profile(lang(l), 'L0', { imports, ...overrides })), resolve: notCalled };
}

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);
const create = (o: Partial<Parameters<typeof LanguageRegistry.create>[0]>) => LanguageRegistry.create({ languages: MVP_LANGUAGES, extractors: [], resolvers: [], ...o });

describe('LanguageRegistry validation', () => {
  it('rejects duplicate languages, conflicting or malformed extensions', () => {
    expect(code(create({ languages: [...MVP_LANGUAGES, { id: lang('ts'), extensions: ['tsz'] }] }))).toBe('REGISTRY_LANGUAGE_DUPLICATE');
    expect(code(create({ languages: [...MVP_LANGUAGES, { id: lang('vue'), extensions: ['ts'] }] }))).toBe('REGISTRY_EXTENSION_CONFLICT');
    expect(code(create({ languages: [{ id: lang('x'), extensions: ['.x'] }] }))).toBe('REGISTRY_EXTENSION_INVALID');
    expect(code(create({ languages: [{ id: lang('x'), extensions: [] }] }))).toBe('REGISTRY_EXTENSION_INVALID');
  });

  it('rejects adapters for unknown languages, duplicate profiles, empty profiles and conflicting adapters', () => {
    expect(code(create({ extractors: [extractor('treesitter', ['dart'])] }))).toBe('REGISTRY_UNKNOWN_LANGUAGE');
    expect(code(create({ extractors: [extractor('treesitter', ['ts', 'ts'])] }))).toBe('REGISTRY_PROFILE_DUPLICATE');
    expect(code(create({ extractors: [extractor('treesitter', [])] }))).toBe('REGISTRY_PROFILE_MISSING');
    expect(code(create({ extractors: [extractor('treesitter', ['ts']), extractor('other', ['ts'])] }))).toBe('REGISTRY_EXTRACTOR_CONFLICT');
    expect(code(create({ resolvers: [resolver('lang-ts', ['ts'], 'L3'), resolver('lang-ts', ['ts'], 'L2')] }))).toBe('REGISTRY_RESOLVER_CONFLICT');
  });
});

describe('LanguageRegistry lookups', () => {
  const treesitter = extractor('treesitter', ['ts', 'tsx', 'js', 'py'], 'L1', { references: 'L0', calls: 'L0', typeRelations: 'L0', di: 'L0' });
  const langTs = resolver('lang-ts', ['ts', 'tsx', 'js'], 'L3', { symbols: 'L3' });
  const heuristicTs = resolver('aaa-heuristic', ['ts'], 'L2');
  const langPy = resolver('lang-python', ['py'], 'L2');
  const registry = unwrap(create({ extractors: [treesitter], resolvers: [heuristicTs, langPy, langTs] }));

  it('maps paths to languages and languages to adapters', () => {
    expect(registry.languageForPath('src/a.mts' as CanonicalPath)).toBe('ts');
    expect(registry.languageForPath('src/README.md' as CanonicalPath)).toBeNull();
    expect(registry.extractorFor(lang('py'))).toBe(treesitter);
    expect(registry.extractorFor(lang('dart'))).toBeNull();
    expect(registry.resolversFor(lang('dart'))).toEqual([]);
  });

  it('orders resolvers by imports fidelity, highest first, then by adapter id', () => {
    expect(registry.resolversFor(lang('ts')).map((r) => r.producer.adapterId)).toEqual(['lang-ts', 'aaa-heuristic']);
    const tie = unwrap(create({ resolvers: [resolver('zeta', ['py'], 'L2'), resolver('alpha', ['py'], 'L2')] }));
    expect(tie.resolversFor(lang('py')).map((r) => r.producer.adapterId)).toEqual(['alpha', 'zeta']);
  });

  it('reports the effective capability matrix: the best declared fidelity per capability', () => {
    const matrix = Object.fromEntries(registry.capabilityMatrix().map((p) => [p.language, p.fidelity]));
    expect(Object.keys(matrix)).toEqual(['js', 'py', 'ts', 'tsx']);
    expect(matrix['ts']).toMatchObject({ symbols: 'L3', imports: 'L3', docstrings: 'L1', references: 'L0', di: 'L0' });
    expect(matrix['py']).toMatchObject({ symbols: 'L1', imports: 'L2', references: 'L0' });
    // A language with no adapter is an explicit all-L0 profile, not a missing entry.
    const bare = unwrap(create({}));
    expect(Object.values(bare.capabilities(lang('py')).fidelity).every((f) => f === 'L0')).toBe(true);
  });
});
