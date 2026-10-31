/**
 * state.db migrations (NFR-022, FF-DAT-005; pattern from CodeForge-v2, E-28).
 *
 * state.db holds local state that cannot be re-derived (job history now; conflicts, the section write log
 * and the LLM cache later), so it is MIGRATED, never rebuilt:
 *  - the chain is forward-only and contiguous from 0;
 *  - each migration runs in its own transaction, together with its bookkeeping row and the user_version bump,
 *    so an interrupted migration leaves the database at the previous version, never in between;
 *  - a database newer than this runtime is refused, never downgraded;
 *  - before migrating an existing database (from > 0), a backup copy state.db.bak-<from> is taken.
 */
import type Database from 'better-sqlite3';
import { domainError, err, ok, type Clock, type DomainError, type Result } from '@cie/core';

export interface Migration {
  readonly id: string;
  readonly from: number;
  readonly to: number;
  readonly description: string;
  up(db: Database.Database): void;
}

export const STATE_MIGRATIONS: readonly Migration[] = [
  {
    id: '0001-meta-and-jobs',
    from: 0,
    to: 1,
    description: 'workspace binding and index job history',
    up(db) {
      db.exec(`
        create table meta (key text primary key, value text not null) strict;
        create table job (
          id text primary key,
          kind text not null check (kind in ('full','incremental','reconcile')),
          state text not null check (state in ('queued','running','succeeded','failed','cancelled')),
          target_seq integer,
          detail text,
          created_at_ms integer not null,
          updated_at_ms integer not null
        ) strict;
        create index job_active on job(state) where state in ('queued','running');
      `);
    },
  },
];

/** Latest schema version this runtime understands. */
export const STATE_SCHEMA_VERSION = STATE_MIGRATIONS.at(-1)?.to ?? 0;

export function validateChain(chain: readonly Migration[]): Result<void, DomainError> {
  let expected = 0;
  for (const m of chain) {
    if (m.from !== expected || m.to !== expected + 1) {
      return err(domainError('MIGRATION_CHAIN_BROKEN', `migration ${m.id} goes ${m.from} -> ${m.to}, expected ${expected} -> ${expected + 1}`));
    }
    expected = m.to;
  }
  return ok(undefined);
}

export interface MigrationOutcome {
  readonly from: number;
  readonly to: number;
  readonly applied: readonly string[];
}

export interface MigrateOptions {
  readonly chain?: readonly Migration[];
  readonly clock: Clock;
  readonly runtimeVersion: string;
  /** Called once, before the first migration of an already-existing database (from > 0). */
  readonly backup?: (fromVersion: number) => void;
}

export function migrate(db: Database.Database, opts: MigrateOptions): Result<MigrationOutcome, DomainError> {
  const chain = opts.chain ?? STATE_MIGRATIONS;
  const valid = validateChain(chain);
  if (!valid.ok) return valid;
  const latest = chain.at(-1)?.to ?? 0;
  const from = db.pragma('user_version', { simple: true }) as number;
  if (from > latest) {
    return err(domainError('STATE_SCHEMA_TOO_NEW', `state.db has schema ${from}, but this runtime supports up to ${latest}; upgrade CIE`, { from, latest }));
  }
  const pending = chain.filter((m) => m.from >= from);
  if (pending.length > 0 && from > 0) opts.backup?.(from);
  const applied: string[] = [];
  for (const m of pending) {
    db.transaction(() => {
      db.exec(`create table if not exists schema_versions (
        schema_version integer primary key, migration_id text not null, description text not null,
        applied_at_ms integer not null, runtime_version text not null) strict`);
      m.up(db);
      db.prepare('insert into schema_versions values (?, ?, ?, ?, ?)').run(m.to, m.id, m.description, opts.clock.nowMs(), opts.runtimeVersion);
      db.pragma(`user_version = ${m.to}`);
    }).immediate();
    applied.push(m.id);
  }
  return ok({ from, to: latest, applied });
}
