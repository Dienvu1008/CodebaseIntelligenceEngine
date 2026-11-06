/**
 * Symbol search over FTS5 (ADR-0008; A-03 verified FTS5 with `unicode61 remove_diacritics 2` in spike S1).
 *  - Head only: `syncSearchIndex` runs inside the publish transaction, removing the symbol row versions
 *    the published revision closed and adding the ones it introduced. Readers therefore see the search
 *    index change together with the head (SN-003), and an abandoned revision never touches it.
 *  - Queries are built from `searchTerms` only: every term becomes a quoted prefix token, so user input can
 *    never reach FTS5 query syntax (no operators, columns or NEAR from the query text).
 *  - Ranking: bm25 with column weights (name 10, qualified name 5, words 3, path 1, doc 0.5), ties broken
 *    by symbol id, so the order is deterministic.
 */
import type Database from 'better-sqlite3';
import { identifierWords, type CodeNode, type SymbolHit, type SymbolKind } from '@cie/core';
import type { VisibleAt } from './structure-store.js';

interface SymbolRow {
  id: number;
  name: string;
  qualified_name: string;
  path: string;
  doc: string | null;
}

export function syncSearchIndex(db: Database.Database, seq: number): void {
  db.prepare(`delete from search_fts where rowid in (select id from node where kind = 'symbol' and valid_to_seq = ?)`).run(seq);
  const rows = db
    .prepare(
      `select n.id, n.name, n.qualified_name, fk.path, n.doc from node n join file_key fk on fk.key = n.file_key
       where n.kind = 'symbol' and n.valid_from_seq = ?`,
    )
    .all(seq) as SymbolRow[];
  const insert = db.prepare('insert into search_fts (rowid, name, qualified_name, words, path, doc) values (?, ?, ?, ?, ?, ?)');
  for (const r of rows) insert.run(r.id, r.name, r.qualified_name, identifierWords(r.qualified_name).join(' '), r.path, r.doc ?? '');
}

/** FTS5 query for already-validated terms: each term quoted (inner quotes doubled) and used as a prefix. */
export const ftsQuery = (terms: readonly string[]): string => terms.map((t) => `"${t.replace(/"/g, '""')}"*`).join(' ');

/** The search statement, exported so the FF-PRF-004 plan test examines exactly what runs. */
export const SEARCH_STATEMENTS = {
  search: (visibleAt: VisibleAt, kindCount: number): string => {
    const kindFilter = kindCount === 0 ? '' : `and n.symbol_kind in (${Array.from({ length: kindCount }, (_, i) => `@k${i}`).join(', ')})`;
    return `select n.data from search_fts s join node n on n.id = s.rowid join node_key k on k.key = n.node_key
       where search_fts match @q and ${visibleAt('n')} ${kindFilter}
       order by bm25(search_fts, 10.0, 5.0, 3.0, 1.0, 0.5), k.node_id limit @limit`;
  },
} as const;

export function searchSymbols(
  db: Database.Database,
  visibleAt: VisibleAt,
  seq: number,
  terms: readonly string[],
  limit: number,
  kinds: readonly SymbolKind[] | undefined,
): { hits: SymbolHit[]; truncated: boolean } {
  const params: Record<string, string | number> = { q: ftsQuery(terms), seq, limit: limit + 1 };
  kinds?.forEach((k, i) => (params[`k${i}`] = k));
  const rows = db.prepare(SEARCH_STATEMENTS.search(visibleAt, kinds?.length ?? 0)).pluck().all(params) as string[];
  const hits = rows.slice(0, limit).map((d): SymbolHit => {
    const n = JSON.parse(d) as CodeNode;
    const s = n.symbol;
    if (s === null || n.file === null || n.language === null) throw new Error(`search index holds a non-symbol row: ${n.id}`);
    return { id: n.id as string as SymbolHit['id'], name: n.name, qualifiedName: s.qualifiedName, kind: s.kind, language: n.language, path: n.file, range: s.range, exported: s.exported };
  });
  return { hits, truncated: rows.length > limit };
}
