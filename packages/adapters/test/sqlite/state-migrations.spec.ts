// FF-DAT-005: migration compatibility of state.db (forward-only, contiguous, transactional, refuses newer
// schemas, backs up before upgrading). Released-schema fixture files (tests/migration/fixtures/state-vN.db)
// start with the first public release; until then the chain is tested programmatically.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { migrate, openStateStore, STATE_MIGRATIONS, STATE_SCHEMA_VERSION, validateChain, WriteConfinement, type Migration } from '@cie/adapters';
import type { WorkspaceId } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeClock } from '../../../../tests/helpers/index-store.js';

let dir: string;
let db: Database.Database;
const clock = new FakeClock();
const opts = { clock, runtimeVersion: 'test' };

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cie-migrate-'));
  db = new Database(path.join(dir, 'state.db'));
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const userVersion = () => db.pragma('user_version', { simple: true });
const tables = () => (db.prepare("select name from sqlite_master where type = 'table' order by name").pluck().all() as string[]);

const addColumn: Migration = {
  id: '0002-test-add-note',
  from: 1,
  to: 2,
  description: 'test: add job.note',
  up: (d) => d.exec('alter table job add column note text'),
};

describe('state.db migrations', () => {
  it('migrates an empty database to the latest version and records it', () => {
    expect(migrate(db, opts)).toEqual({ ok: true, value: { from: 0, to: STATE_SCHEMA_VERSION, applied: STATE_MIGRATIONS.map((m) => m.id) } });
    expect(userVersion()).toBe(STATE_SCHEMA_VERSION);
    expect(db.prepare('select schema_version, migration_id from schema_versions').all()).toEqual([{ schema_version: 1, migration_id: '0001-meta-and-jobs' }]);
  });

  it('is idempotent: re-running applies nothing', () => {
    migrate(db, opts);
    expect(migrate(db, opts)).toMatchObject({ ok: true, value: { applied: [] } });
  });

  it('applies only the pending tail and backs up first when upgrading an existing database', () => {
    migrate(db, opts);
    const backups: number[] = [];
    const r = migrate(db, { ...opts, chain: [...STATE_MIGRATIONS, addColumn], backup: (from) => backups.push(from) });
    expect(r).toMatchObject({ ok: true, value: { from: 1, to: 2, applied: ['0002-test-add-note'] } });
    expect(backups).toEqual([1]);
  });

  it('refuses a database newer than the runtime and leaves it untouched', () => {
    migrate(db, opts);
    db.pragma('user_version = 99');
    const before = tables();
    const r = migrate(db, opts);
    expect(r.ok === false && r.error.code).toBe('STATE_SCHEMA_TOO_NEW');
    expect(userVersion()).toBe(99);
    expect(tables()).toEqual(before);
  });

  it('rolls an interrupted migration back completely: the database stays at the previous version', () => {
    migrate(db, opts);
    const exploding: Migration = {
      id: '0002-explodes',
      from: 1,
      to: 2,
      description: 'creates a table, then fails',
      up: (d) => {
        d.exec('create table half_done (x integer) strict');
        throw new Error('power cut');
      },
    };
    expect(() => migrate(db, { ...opts, chain: [...STATE_MIGRATIONS, exploding] })).toThrow('power cut');
    expect(userVersion()).toBe(1);
    expect(tables()).not.toContain('half_done');
    expect(db.prepare('select count(*) from schema_versions where schema_version = 2').pluck().get()).toBe(0);
  });

  it.each([
    [[{ ...addColumn, from: 0, to: 1, id: 'a' }, { ...addColumn, from: 2, to: 3, id: 'b' }]],
    [[{ ...addColumn, from: 1, to: 2 }]],
    [[{ ...addColumn, from: 0, to: 2 }]],
  ])('rejects a non-contiguous chain', (chain) => {
    expect(validateChain(chain).ok).toBe(false);
  });
});

describe('openStateStore', () => {
  it('binds state.db to its workspace (WS-003), quarantines corruption, and records jobs', async () => {
    const stateDir = path.join(dir, 'ws', '.cie');
    const gate = await WriteConfinement.create({ workspaceRoot: path.join(dir, 'ws') });
    const open = (id: string) => openStateStore({ stateDir, workspaceId: id as WorkspaceId, clock, confinement: gate });

    const a = await open('ws_A');
    if (!a.ok) throw new Error(a.error.code);
    await a.value.jobs.save({ id: 'j1' as never, kind: 'full', state: 'running', targetSeq: null });
    expect((await a.value.jobs.listActive()).map((j) => j.id)).toEqual(['j1']);
    a.value.close();

    const wrong = await open('ws_B');
    expect(wrong.ok === false && wrong.error.code).toBe('STORE_WORKSPACE_MISMATCH');

    writeFileSync(path.join(stateDir, 'state.db'), 'garbage'.repeat(500));
    const healed = await open('ws_A');
    if (!healed.ok) throw new Error(healed.error.code);
    expect(healed.value.quarantinedAs).toMatch(/^state\.db\.corrupt-\d+$/);
    expect(existsSync(path.join(stateDir, healed.value.quarantinedAs ?? ''))).toBe(true);
    healed.value.close();
  });
});
