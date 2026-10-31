/**
 * state.db: local, non-derivable state (ADR-0007, SECURITY_AND_RELIABILITY §3.2).
 * Opening it validates the workspace binding (WS-003), runs pending migrations (with a backup first), and
 * quarantines a corrupt file. Salvaging data out of a corrupt state.db is deferred to the phase that first
 * stores data worth salvaging (Phase 04, conflicts); job history is diagnostic only.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  domainError,
  err,
  ok,
  type Clock,
  type DomainError,
  type JobId,
  type JobRecord,
  type JobRepository,
  type Result,
  type RevisionSeq,
  type WorkspaceId,
} from '@cie/core';
import type { StateWriteGate } from './open.js';
import { migrate, type MigrationOutcome } from './state-migrations.js';

export const RUNTIME_VERSION = '0.0.0';

interface JobRow {
  id: string;
  kind: JobRecord['kind'];
  state: JobRecord['state'];
  target_seq: number | null;
}

const toJob = (r: JobRow): JobRecord => ({ id: r.id as JobId, kind: r.kind, state: r.state, targetSeq: r.target_seq as RevisionSeq | null });

export class SqliteJobRepository implements JobRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  async save(job: JobRecord): Promise<void> {
    const now = this.clock.nowMs();
    this.db
      .prepare(`insert into job (id, kind, state, target_seq, created_at_ms, updated_at_ms) values (@id, @kind, @state, @target, @now, @now)
                on conflict(id) do update set state = excluded.state, target_seq = excluded.target_seq, updated_at_ms = excluded.updated_at_ms`)
      .run({ id: job.id, kind: job.kind, state: job.state, target: job.targetSeq, now });
  }

  async get(id: JobId): Promise<JobRecord | null> {
    const row = this.db.prepare('select id, kind, state, target_seq from job where id = ?').get(id) as JobRow | undefined;
    return row === undefined ? null : toJob(row);
  }

  async listActive(): Promise<readonly JobRecord[]> {
    const rows = this.db.prepare("select id, kind, state, target_seq from job where state in ('queued','running') order by created_at_ms, id").all() as JobRow[];
    return rows.map(toJob);
  }

  /** Most recent jobs first, for `cie dev status`. */
  recent(limit: number): readonly JobRecord[] {
    return (this.db.prepare('select id, kind, state, target_seq from job order by updated_at_ms desc, id limit ?').all(limit) as JobRow[]).map(toJob);
  }
}

export interface OpenedStateStore {
  readonly jobs: SqliteJobRepository;
  readonly migration: MigrationOutcome;
  readonly quarantinedAs?: string;
  close(): void;
}

export interface OpenStateStoreOptions {
  readonly stateDir: string;
  readonly workspaceId: WorkspaceId;
  readonly clock: Clock;
  readonly confinement: StateWriteGate;
}

function quarantine(file: string, clock: Clock): string {
  const dir = path.dirname(file);
  for (const old of readdirSync(dir).filter((n) => n.startsWith('state.db.corrupt-'))) rmSync(path.join(dir, old), { force: true });
  const target = `${file}.corrupt-${clock.nowMs()}`;
  renameSync(file, target);
  for (const s of ['-wal', '-shm']) rmSync(file + s, { force: true });
  return path.basename(target);
}

function openVerified(file: string, clock: Clock): { db: Database.Database; quarantinedAs?: string } {
  if (!existsSync(file)) return { db: new Database(file) };
  let probe: Database.Database | undefined;
  try {
    probe = new Database(file);
    if (probe.pragma('quick_check', { simple: true }) === 'ok') return { db: probe };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== 'SQLITE_CORRUPT' && code !== 'SQLITE_NOTADB') {
      probe?.close();
      throw e;
    }
  }
  // Close before renaming: Windows refuses to rename a file that is still open (found in Phase 01).
  probe?.close();
  const quarantinedAs = quarantine(file, clock);
  return { db: new Database(file), quarantinedAs };
}

export async function openStateStore(opts: OpenStateStoreOptions): Promise<Result<OpenedStateStore, DomainError>> {
  const file = path.join(opts.stateDir, 'state.db');
  const allowed = await opts.confinement.check(file, 'state');
  if (!allowed.ok) return allowed;
  mkdirSync(opts.stateDir, { recursive: true });
  const { db, quarantinedAs } = openVerified(file, opts.clock);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = FULL'); // non-derivable data: full durability (SECURITY_AND_RELIABILITY §3.2)
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const migrated = migrate(db, {
    clock: opts.clock,
    runtimeVersion: RUNTIME_VERSION,
    backup: (from) => {
      db.pragma('wal_checkpoint(TRUNCATE)');
      copyFileSync(file, `${file}.bak-${from}`);
    },
  });
  if (!migrated.ok) {
    db.close();
    return migrated;
  }
  const bound = db.prepare("select value from meta where key = 'workspace_id'").pluck().get() as string | undefined;
  if (bound === undefined) db.prepare("insert into meta (key, value) values ('workspace_id', ?)").run(opts.workspaceId);
  else if (bound !== opts.workspaceId) {
    db.close();
    return err(domainError('STORE_WORKSPACE_MISMATCH', 'state.db belongs to a different workspace (WS-003)', { expected: opts.workspaceId, found: bound }));
  }
  return ok({
    jobs: new SqliteJobRepository(db, opts.clock),
    migration: migrated.value,
    ...(quarantinedAs === undefined ? {} : { quarantinedAs }),
    close: () => db.close(),
  });
}
