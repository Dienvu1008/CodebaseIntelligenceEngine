// Spike S1 (Phase 01 entry, checklist P01-01; assumptions A-02 and A-03).
// Question: does better-sqlite3 load and give us WAL, foreign keys, FTS5 and WAL snapshot isolation on
// every CI cell (windows/ubuntu x Node 24/26)? The results feed ADR-0004 and ADR-0008. This test stays
// as a permanent platform canary: it fails loudly if a dependency or Node upgrade breaks the storage
// foundation.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(path.join(tmpdir(), 'cie-s1-'));
const file = path.join(dir, 'spike.db');
const writer = new Database(file);

afterAll(() => {
  writer.close();
  rmSync(dir, { recursive: true, force: true });
});

const scalar = <T>(db: Database.Database, sql: string): T => db.prepare(sql).pluck().get() as T;

describe(`spike S1 on ${process.platform}-${process.arch}, Node ${process.versions.node}`, () => {
  it('loads the native binding and reports the bundled SQLite version', () => {
    const version = scalar<string>(writer, 'select sqlite_version()');
    console.log(`[S1] node=${process.versions.node} platform=${process.platform}-${process.arch} sqlite=${version}`);
    expect(version).toMatch(/^3\.\d+\.\d+$/);
  });

  it('switches to WAL journal mode on a file database', () => {
    expect(writer.pragma('journal_mode = WAL', { simple: true })).toBe('wal');
  });

  it('enforces foreign keys when enabled (FF-DAT-001 premise)', () => {
    writer.pragma('foreign_keys = ON');
    writer.exec('create table parent(id integer primary key); create table child(pid integer not null references parent(id));');
    expect(() => writer.prepare('insert into child(pid) values (42)').run()).toThrow(/FOREIGN KEY/);
  });

  it('provides FTS5 with the unicode61 tokenizer (A-03, ADR-0008)', () => {
    writer.exec(
      "create virtual table search_fts using fts5(node_key unindexed, name, qualified_name, tokenize = 'unicode61 remove_diacritics 2')",
    );
    const insert = writer.prepare('insert into search_fts(node_key, name, qualified_name) values (?, ?, ?)');
    insert.run(1, 'SessionStore', 'auth.SessionStore');
    insert.run(2, 'refresh', 'auth.SessionStore.refresh');
    insert.run(3, 'Café', 'menu.Café');
    const match = (q: string): number[] =>
      writer.prepare('select node_key from search_fts where search_fts match ? order by node_key').pluck().all(q) as number[];
    expect(match('refresh')).toEqual([2]);
    expect(match('name : Sess*')).toEqual([1]); // column filter + prefix query
    expect(match('Sess*')).toEqual([1, 2]); // without a column filter, qualified_name matches too
    expect(match('cafe')).toEqual([3]); // remove_diacritics
  });

  it('isolates a WAL reader from an uncommitted writer transaction (SN-003 premise, ADR-0015)', () => {
    writer.exec('create table head(id integer primary key check (id = 1), seq integer not null); insert into head values (1, 0);');
    const reader = new Database(file, { readonly: true });
    try {
      const readSeq = (): number => scalar<number>(reader, 'select seq from head');
      writer.exec('begin immediate');
      writer.prepare('update head set seq = 1 where seq = 0').run();
      expect(readSeq()).toBe(0); // the staged change is invisible to readers
      writer.exec('commit');
      expect(readSeq()).toBe(1); // the publish becomes visible atomically
    } finally {
      reader.close();
    }
  });

  it('reports changes() for a compare-and-swap publish (SN-002 premise)', () => {
    const cas = writer.prepare('update head set seq = ? where seq = ?');
    expect(cas.run(2, 1).changes).toBe(1);
    expect(cas.run(3, 1).changes).toBe(0); // stale base: no rows updated, so a PublishConflict
  });
});
