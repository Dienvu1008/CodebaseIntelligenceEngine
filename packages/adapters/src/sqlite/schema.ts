/**
 * index.db lifecycle: open, verify, quarantine and (re)create (ADR-0008, NFR-021, NFR-022, WS-003).
 *
 * index.db holds only derived data, so it is never migrated. A schema-version mismatch or a corrupt file
 * leads to a fresh database and a full re-index. A database that belongs to a different workspace is
 * refused rather than silently replaced: the user decides (WS-003 b).
 */
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { domainError, err, ok, type Clock, type DomainError, type Result, type WorkspaceId } from '@cie/core';

/** Bump whenever the DDL below changes. Older files are rebuilt. */
export const INDEX_SCHEMA_VERSION = 4;

const DDL = `
create table meta (key text primary key, value text not null) strict;

create table workspace_head (
  id integer primary key check (id = 1),
  current_seq integer,
  watermark integer not null
) strict;

create table index_revision (
  seq integer primary key,
  base_seq integer,
  status text not null check (status in ('building','validating','published','superseded','abandoned')),
  watermark integer not null,
  job_id text not null,
  staged integer not null default 0,
  abandon_reason text,
  created_at_ms integer not null,
  published_at_ms integer
) strict;

create table index_lease (
  id integer primary key check (id = 1),
  holder text,
  expires_at_ms integer not null
) strict;

-- Stable identity keys: append-only, never revision-scoped (ADR-0015, contradiction log C-02).
create table file_key (key integer primary key, path text not null unique) strict;

-- One row per file version; visibility is defined only by visibleAt() in index-store.ts (ADR-0015, FF-BND-003).
create table file (
  id integer primary key,
  file_key integer not null references file_key(key),
  status text not null check (status in ('indexed','skipped')),
  hash text,
  skip_reason text,
  size integer not null check (size >= 0),
  lang text,
  valid_from_seq integer not null,
  valid_to_seq integer,
  check ((status = 'indexed' and hash is not null and skip_reason is null)
      or (status = 'skipped' and hash is null and skip_reason is not null and lang is null)),
  check (valid_to_seq is null or valid_to_seq > valid_from_seq)
) strict;
create index file_key_vis on file(file_key, valid_to_seq);
create index file_from on file(valid_from_seq);
create index file_to on file(valid_to_seq);
create unique index file_head_unique on file(file_key) where valid_to_seq is null;

-- Nodes. Stable node_key, versioned rows (ADR-0015).
--  * structural (FR-006, Phase 01): directory, package, project;
--  * code (Phase 02): module, symbol, external, unresolved. They always record their producer and fidelity
--    (SY-005), and \`data\` holds the canonical JSON of the projected record (row equality = same version).
create table node_key (key integer primary key, node_id text not null unique, kind text not null) strict;
create table node (
  id integer primary key,
  node_key integer not null references node_key(key),
  kind text not null check (kind in ('directory','package','project','module','symbol','external','unresolved')),
  name text not null,
  ecosystem text,
  file_key integer references file_key(key),
  lang text,
  qualified_name text,
  symbol_kind text,
  start_line integer, start_col integer, end_line integer, end_col integer,
  span_hash text,
  body_fingerprint text,
  exported integer check (exported in (0, 1)),
  doc text,
  producer text,
  fidelity text check (fidelity in ('L0','L1','L2','L3')),
  data text,
  valid_from_seq integer not null,
  valid_to_seq integer,
  check (valid_to_seq is null or valid_to_seq > valid_from_seq),
  check (kind in ('directory','package','project') or (producer is not null and fidelity is not null and data is not null)),
  check (kind not in ('module','symbol') or file_key is not null),
  check (kind <> 'symbol' or (qualified_name is not null and symbol_kind is not null and start_line is not null
                              and span_hash is not null and body_fingerprint is not null and exported is not null))
) strict;
create index node_key_vis on node(node_key, valid_to_seq);
create index node_file_vis on node(file_key, valid_to_seq);
create index node_from on node(valid_from_seq);
create index node_to on node(valid_to_seq);
create unique index node_head_unique on node(node_key) where valid_to_seq is null;

-- Edges (KNOWLEDGE_GRAPH_DESIGN §3–§5). Endpoints reference stable node keys: the FK guarantees the identity
-- exists, the RevisionValidator guarantees both endpoints are visible at the edge's seq (KG-001).
create table edge (
  id integer primary key,
  type text not null check (type in ('contains','defines','exports','imports','imports_symbol')),
  from_key integer not null references node_key(key),
  to_key integer not null references node_key(key),
  site_key text not null default '',
  status text not null check (status in ('verified','inferred','user_asserted','unknown')),
  precision text check (precision in ('exact','heuristic')),
  producer text not null,
  fidelity text not null check (fidelity in ('L0','L1','L2','L3')),
  ev_kind text,
  ev_file_key integer references file_key(key),
  ev_start_line integer, ev_start_col integer, ev_end_line integer, ev_end_col integer,
  ev_content_hash text,
  data text not null,
  valid_from_seq integer not null,
  valid_to_seq integer,
  check (valid_to_seq is null or valid_to_seq > valid_from_seq)
) strict;
create index edge_out on edge(from_key, type, valid_to_seq);
create index edge_in on edge(to_key, type, valid_to_seq);
create index edge_from on edge(valid_from_seq);
create index edge_to on edge(valid_to_seq);
create unique index edge_head_unique on edge(type, from_key, to_key, site_key) where valid_to_seq is null;

-- Symbol search (ADR-0008, KNOWLEDGE_GRAPH_DESIGN §5): head only, maintained inside the publish transaction.
-- rowid = node.id of the symbol row version; \`words\` holds identifierWords(qualified name).
create virtual table search_fts using fts5(name, qualified_name, words, path, doc, tokenize = 'unicode61 remove_diacritics 2');

insert into workspace_head (id, current_seq, watermark) values (1, null, 0);
insert into index_lease (id, holder, expires_at_ms) values (1, null, 0);
`;

export type OpenOutcome = 'opened' | 'created' | 'rebuilt-schema' | 'quarantined-corrupt';

export interface OpenedIndex {
  readonly db: Database.Database;
  readonly outcome: OpenOutcome;
  /** Name of the quarantined file, when outcome is 'quarantined-corrupt'. */
  readonly quarantinedAs?: string;
}

const SIDE_FILES = ['', '-wal', '-shm'];

function configure(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL'); // derived data: durability trade-off accepted (SECURITY_AND_RELIABILITY §3.2)
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
}

function create(file: string, workspaceId: WorkspaceId, clock: Clock): Database.Database {
  const db = new Database(file);
  configure(db);
  db.transaction(() => {
    db.exec(DDL);
    const meta = db.prepare('insert into meta (key, value) values (?, ?)');
    meta.run('workspace_id', workspaceId);
    meta.run('schema_version', String(INDEX_SCHEMA_VERSION));
    meta.run('created_at_ms', String(clock.nowMs()));
  })();
  return db;
}

function removeWithSideFiles(file: string): void {
  for (const s of SIDE_FILES) rmSync(file + s, { force: true });
}

/** Moves a corrupt database aside, keeping only the most recent quarantined copy. */
function quarantine(file: string, clock: Clock): string {
  const dir = path.dirname(file);
  const base = path.basename(file);
  for (const old of readdirSync(dir).filter((n) => n.startsWith(`${base}.corrupt-`))) rmSync(path.join(dir, old), { force: true });
  const target = `${file}.corrupt-${clock.nowMs()}`;
  renameSync(file, target);
  for (const s of ['-wal', '-shm']) rmSync(file + s, { force: true });
  return path.basename(target);
}

type Probe =
  | { readonly kind: 'ok'; readonly db: Database.Database }
  | { readonly kind: 'corrupt' }
  | { readonly kind: 'schema-mismatch' }
  | { readonly kind: 'workspace-mismatch'; readonly found: string };

function probe(file: string, workspaceId: WorkspaceId, readonly: boolean): Probe {
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { readonly, fileMustExist: true });
    if (db.pragma('quick_check', { simple: true }) !== 'ok') {
      db.close();
      return { kind: 'corrupt' };
    }
    const rows = db.prepare("select key, value from meta where key in ('workspace_id','schema_version')").all() as Array<{ key: string; value: string }>;
    const meta = new Map(rows.map((r) => [r.key, r.value]));
    const found = meta.get('workspace_id');
    if (found !== undefined && found !== workspaceId) {
      db.close();
      return { kind: 'workspace-mismatch', found };
    }
    if (found === undefined || meta.get('schema_version') !== String(INDEX_SCHEMA_VERSION)) {
      db.close();
      return { kind: 'schema-mismatch' };
    }
    if (!readonly) configure(db);
    else db.pragma('foreign_keys = ON');
    return { kind: 'ok', db };
  } catch (e) {
    db?.close();
    const code = (e as { code?: string }).code;
    if (code === 'SQLITE_CORRUPT' || code === 'SQLITE_NOTADB' || /no such table: meta/.test(String(e))) return { kind: 'corrupt' };
    throw e;
  }
}

export interface OpenIndexOptions {
  readonly file: string;
  readonly workspaceId: WorkspaceId;
  readonly clock: Clock;
  /** Followers open read-only and never create, rebuild or quarantine (ADR-0002). */
  readonly readonly: boolean;
}

export function openIndexDatabase(opts: OpenIndexOptions): Result<OpenedIndex, DomainError> {
  const { file, workspaceId, clock } = opts;
  if (!existsSync(file)) {
    if (opts.readonly) return err(domainError('INDEX_NOT_READY', 'no index exists yet for this workspace'));
    return ok({ db: create(file, workspaceId, clock), outcome: 'created' });
  }
  const p = probe(file, workspaceId, opts.readonly);
  switch (p.kind) {
    case 'ok':
      return ok({ db: p.db, outcome: 'opened' });
    case 'workspace-mismatch':
      return err(domainError('STORE_WORKSPACE_MISMATCH', 'this index belongs to a different workspace (WS-003); remove it to rebuild', {
        expected: workspaceId,
        found: p.found,
      }));
    case 'schema-mismatch':
      if (opts.readonly) return err(domainError('INDEX_NOT_READY', 'the index schema is outdated; a writer must rebuild it'));
      removeWithSideFiles(file);
      return ok({ db: create(file, workspaceId, clock), outcome: 'rebuilt-schema' });
    case 'corrupt': {
      if (opts.readonly) return err(domainError('INDEX_NOT_READY', 'the index is corrupt; a writer must rebuild it'));
      const quarantinedAs = quarantine(file, clock);
      return ok({ db: create(file, workspaceId, clock), outcome: 'quarantined-corrupt', quarantinedAs });
    }
  }
}
