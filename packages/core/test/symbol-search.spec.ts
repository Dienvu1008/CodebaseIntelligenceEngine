// Symbol search rules: query terms, identifier words, limits.
import { clampSearchLimit, identifierWords, MAX_SEARCH_LIMIT, searchTerms } from '@cie/core';
import { describe, expect, it } from 'vitest';

const terms = (t: string) => {
  const r = searchTerms(t);
  return r.ok ? r.value : r.error.code;
};

describe('searchTerms', () => {
  it('keeps letters and digits only, lower-cased; everything else separates terms', () => {
    expect(terms('Session store')).toEqual(['session', 'store']);
    expect(terms('make_user')).toEqual(['make', 'user']);
    expect(terms('"; DROP TABLE node; --')).toEqual(['drop', 'table', 'node']);
    expect(terms('NEAR(a b) name:x *')).toEqual(['near', 'a', 'b', 'name', 'x']);
    expect(terms('Café 名前 v2')).toEqual(['café', '名前', 'v2']);
  });

  it('rejects empty, oversized and over-long queries', () => {
    expect(terms('  *** ')).toBe('SEARCH_QUERY_EMPTY');
    expect(terms(Array.from({ length: 17 }, (_, i) => `t${i}`).join(' '))).toBe('SEARCH_QUERY_TOO_LONG');
    expect(terms('x'.repeat(65))).toBe('SEARCH_QUERY_TOO_LONG');
  });
});

describe('identifierWords', () => {
  it('splits camelCase, PascalCase, acronyms, digits and separators into distinct words', () => {
    expect(identifierWords('SessionStore.refresh')).toEqual(['session', 'store', 'refresh']);
    expect(identifierWords('HTTPServerError')).toEqual(['http', 'server', 'error']);
    expect(identifierWords('parseURL2')).toEqual(['parse', 'url', '2']);
    expect(identifierWords('make_user.make_user')).toEqual(['make', 'user']);
    expect(identifierWords('%23items')).toEqual(['23', 'items']);
    expect(identifierWords('名前Value')).toEqual(['名前', 'value']);
  });
});

describe('clampSearchLimit', () => {
  it('defaults, and clamps to 1..MAX_SEARCH_LIMIT', () => {
    expect(clampSearchLimit(undefined)).toBe(20);
    expect([clampSearchLimit(0), clampSearchLimit(-3), clampSearchLimit(7.9), clampSearchLimit(10_000), clampSearchLimit(Number.NaN)]).toEqual([1, 1, 7, MAX_SEARCH_LIMIT, 20]);
  });
});
