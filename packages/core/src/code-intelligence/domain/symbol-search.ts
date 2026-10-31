/**
 * Symbol search rules (FR symbols.search, KNOWLEDGE_GRAPH_DESIGN §5 FTS). Pure: the adapter turns the terms
 * into its own query syntax, but never passes user text through unparsed.
 *  - A query is split into terms of letters and digits (Unicode). Everything else separates terms, which
 *    matches how the index tokenizes names (`make_user` → make, user). Each term matches as a prefix, and
 *    all terms must match.
 *  - `identifierWords` splits identifiers into words (camelCase, PascalCase, acronyms, digits, `_`/`$`),
 *    so `store` finds `SessionStore` and `url` finds `parseURL`.
 *  - Results are bounded: `limit` is clamped to 1..MAX_SEARCH_LIMIT and the answer says when it was
 *    truncated (KG-004 style).
 */
import type { DomainError, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';

export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 200;
export const MAX_SEARCH_TERMS = 16;
export const MAX_TERM_LENGTH = 64;

const TERM = /[\p{L}\p{N}]+/gu;

/** Lower-cased search terms of a query; fails on an empty query or one with too many or too long terms. */
export function searchTerms(text: string): Result<readonly string[], DomainError> {
  const terms = [...text.normalize('NFC').matchAll(TERM)].map((m) => m[0].toLowerCase());
  if (terms.length === 0) return err(domainError('SEARCH_QUERY_EMPTY', 'the query has no letters or digits'));
  if (terms.length > MAX_SEARCH_TERMS) return err(domainError('SEARCH_QUERY_TOO_LONG', `at most ${MAX_SEARCH_TERMS} terms are allowed`, { terms: terms.length }));
  const long = terms.find((t) => t.length > MAX_TERM_LENGTH);
  if (long !== undefined) return err(domainError('SEARCH_QUERY_TOO_LONG', `a term is longer than ${MAX_TERM_LENGTH} characters`));
  return ok(terms);
}

export function clampSearchLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.trunc(limit)));
}

// Acronym run not followed by a lower-case letter (HTTP in HTTPServer), a capitalised or lower-case word,
// or a digit run. Applied per alphanumeric chunk.
// Letters without case (CJK, Arabic, …) form their own words, so `名前Value` → 名前, value.
const WORD = /\p{Lu}+(?!\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lt}\p{Ll}*|[\p{Lo}\p{Lm}]+|\p{N}+/gu;

/** Distinct lower-case words of an identifier or qualified name, in order of first appearance. */
export function identifierWords(identifier: string): readonly string[] {
  const out: string[] = [];
  for (const chunk of identifier.normalize('NFC').match(TERM) ?? []) {
    for (const w of chunk.match(WORD) ?? []) {
      const lower = w.toLowerCase();
      if (!out.includes(lower)) out.push(lower);
    }
  }
  return out;
}
