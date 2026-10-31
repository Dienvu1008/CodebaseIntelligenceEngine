// index.db lifecycle (NFR-021, NFR-022): creation, corruption quarantine and rebuild, schema-version
// rebuild, follower behavior, and the SEC-002 write gate on the state directory.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openIndexStore, WriteConfinement } from '@cie/adapters';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { file, publishRevision, sandbox, WS_A, type Sandbox } from '../../../../tests/helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

describe('index.db lifecycle', () => {
  it('creates a fresh database on first open', async () => {
    const o = await sb.open();
    expect(o.outcome).toBe('created');
    expect(await o.store.head()).toBeNull();
  });

  it('quarantines a corrupt file, keeps one copy, and starts fresh', async () => {
    const dbFile = path.join(sb.stateDir, 'index.db');
    (await sb.open()).close();
    writeFileSync(dbFile, Buffer.from('this is not a sqlite database at all, just garbage bytes'.repeat(100)));
    const o = await sb.open();
    expect(o.outcome).toBe('quarantined-corrupt');
    expect(o.quarantinedAs).toMatch(/^index\.db\.corrupt-\d+$/);
    expect(readdirSync(sb.stateDir).filter((n) => n.includes('.corrupt-'))).toHaveLength(1);
    await o.store.lease.acquire('writer-1', 60_000);
    expect(await publishRevision(o, [file('a.ts', 'a')])).toBe(1);
  });

  it('rebuilds when the schema version differs (index.db is derived and never migrated)', async () => {
    const dbFile = path.join(sb.stateDir, 'index.db');
    (await sb.open()).close();
    const raw = new Database(dbFile);
    raw.prepare("update meta set value = '0' where key = 'schema_version'").run();
    raw.close();
    expect((await sb.open()).outcome).toBe('rebuilt-schema');
  });

  it('never creates, rebuilds or quarantines as a read-only follower', async () => {
    await expect(sb.open({ mode: 'follower' })).rejects.toMatchObject({ code: 'INDEX_NOT_READY' });
    expect(existsSync(path.join(sb.stateDir, 'index.db'))).toBe(false);
  });

  it('refuses a state directory that the write gate does not permit (SEC-002)', async () => {
    const strict = await WriteConfinement.create({ workspaceRoot: sb.workspace });
    const r = await openIndexStore({
      stateDir: path.join(sb.workspace, 'src'),
      workspaceId: WS_A,
      clock: sb.clock,
      mode: 'writer',
      holder: 'w',
      confinement: strict,
    });
    expect(r.ok === false && r.error.code).toBe('WRITE_NOT_PERMITTED');
    expect(existsSync(path.join(sb.workspace, 'src'))).toBe(false);
  });
});
