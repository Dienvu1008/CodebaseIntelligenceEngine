// P02-09: FTS5 symbol search over the published head. The search index changes together with the head
// (inside the publish transaction), never with a staging or abandoned revision; renamed symbols move;
// user text never reaches FTS5 syntax; ordering is deterministic; results are bounded.
import path from 'node:path';
import Database from 'better-sqlite3';
import type { RevisionSeq, SymbolQuery } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeGraphOf } from '../helpers/code-graph.js';
import { job, publishRevision, sandbox, stageAll, type Sandbox } from '../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

async function writer() {
  const o = await sb.open();
  await o.store.lease.acquire('writer-1', 60_000);
  return o;
}

type Store = Awaited<ReturnType<typeof writer>>['store'];
async function names(store: Store, seq: RevisionSeq, query: SymbolQuery): Promise<string[]> {
  const r = await store.searchSymbols(seq, query);
  if (!r.ok) throw new Error(r.error.code);
  return r.value.hits.map((h) => h.id);
}

const V1 = {
  'src/session.ts': '/** Keeps sessions fresh. */\nexport class SessionStore {\n  refresh() {}\n}\nexport function parseURL(u: string) { return u }\n',
  'pkg/café.py': 'def café_au_lait():\n    pass\n\nclass Résumé:\n    pass\n',
};

describe('symbol search', () => {
  it('finds symbols by name, qualified name, identifier words and prefixes, ranking name matches first', async () => {
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(V1);
    const seq = await publishRevision(o, manifest, 0, graph);
    expect(await names(o.store, seq, { text: 'SessionStore' })).toEqual(['ts:src/session.ts#SessionStore(class)', 'ts:src/session.ts#SessionStore.refresh(method)']);
    expect(await names(o.store, seq, { text: 'store refresh' })).toEqual(['ts:src/session.ts#SessionStore.refresh(method)']);
    expect(await names(o.store, seq, { text: 'url' })).toEqual(['ts:src/session.ts#parseURL(function)']);
    expect(await names(o.store, seq, { text: 'sess' })).toContain('ts:src/session.ts#SessionStore(class)');
    // Diacritics are folded (unicode61 remove_diacritics 2), in both directions. The path column matches too
    // (pkg/café.py), with a lower weight, so the symbol named café ranks first.
    expect(await names(o.store, seq, { text: 'cafe' })).toEqual(['py:pkg/café.py#café_au_lait(function)', 'py:pkg/café.py#Résumé(class)']);
    expect(await names(o.store, seq, { text: 'resume' })).toEqual(['py:pkg/café.py#Résumé(class)']);
    expect(await names(o.store, seq, { text: 'refresh', kinds: ['class'] })).toEqual([]);
  });

  it('is safe against FTS5 syntax in user text, and bounded', async () => {
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(V1);
    const seq = await publishRevision(o, manifest, 0, graph);
    for (const text of ['Session"', 'SessionStore"*', 'NEAR(Session store)', 'name:Session', 'Session OR x', '-Session', '^Session', 'Session AND NOT x']) {
      const r = await o.store.searchSymbols(seq, { text });
      expect(r.ok, text).toBe(true);
    }
    const one = await o.store.searchSymbols(seq, { text: 'session', limit: 1 });
    expect(one.ok && [one.value.hits.length, one.value.truncated]).toEqual([1, true]);
    const r = await o.store.searchSymbols(seq, { text: '***' });
    expect(r.ok === false && r.error.code).toBe('SEARCH_QUERY_EMPTY');
  });

  it('moves with the head: renames replace old names, abandoned revisions change nothing, old seqs are refused', async () => {
    const o = await writer();
    const v1 = await codeGraphOf(V1);
    const s1 = await publishRevision(o, v1.manifest, 0, v1.graph);
    const v2 = await codeGraphOf({ ...V1, 'src/session.ts': 'export class SessionCache {\n  refresh() {}\n}\n' });
    const s2 = await publishRevision(o, v2.manifest, 0, v2.graph);
    expect(await names(o.store, s2, { text: 'SessionStore' })).toEqual([]);
    expect(await names(o.store, s2, { text: 'cache' })).toEqual(['ts:src/session.ts#SessionCache(class)', 'ts:src/session.ts#SessionCache.refresh(method)']);
    expect(await names(o.store, s2, { text: 'cafe au lait' })).toEqual(['py:pkg/café.py#café_au_lait(function)']); // unchanged file stays searchable

    // A staged-then-abandoned revision that removes everything leaves the search index untouched.
    const rev = await o.store.begin(s2, job('j3'));
    if (!rev.ok) throw new Error(rev.error.code);
    await stageAll(o, rev.value.seq, []);
    await o.store.abandon(rev.value.seq, 'test');
    expect(await names(o.store, s2, { text: 'cache' })).toHaveLength(2);

    const old = await o.store.searchSymbols(s1, { text: 'session' });
    expect(old.ok === false && old.error.code).toBe('SEARCH_HEAD_ONLY');

    // Reads re-check visibility, so stale rows could never be returned; but the index must also hold exactly
    // the head's symbols, or it grows with every revision and skews bm25 statistics.
    o.close();
    const db = new Database(path.join(sb.stateDir, 'index.db'), { readonly: true });
    try {
      const fts = db.prepare('select count(*) from search_fts').pluck().get() as number;
      const head = db.prepare("select count(*) from node where kind = 'symbol' and valid_to_seq is null").pluck().get() as number;
      expect(fts).toBe(head);
    } finally {
      db.close();
    }
  });

  it('returns the same order every time', async () => {
    const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/m${i}.ts`, `export function handler${i}() {}\nexport const handlerName${i} = 1;\n`]));
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(files);
    const seq = await publishRevision(o, manifest, 0, graph);
    const first = await names(o.store, seq, { text: 'handler', limit: 200 });
    expect(first).toHaveLength(24);
    expect(await names(o.store, seq, { text: 'handler', limit: 200 })).toEqual(first);
  });
});
