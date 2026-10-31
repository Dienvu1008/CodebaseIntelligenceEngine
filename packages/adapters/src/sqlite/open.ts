/**
 * Entry point for opening the index store. Every writer path goes through WriteConfinement (SEC-002)
 * before SQLite is allowed to create or modify a file.
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { domainError, err, ok, type Clock, type DomainError, type Result, type WorkspaceId } from '@cie/core';
import { SqliteIndexStore } from './index-store.js';

/**
 * The write gate this adapter needs. It is structural, so that adapters/sqlite does not import
 * adapters/fs (DEPENDENCY_RULES A1); the composition root injects WriteConfinement.
 */
export interface StateWriteGate {
  check(target: string, purpose: 'state'): Promise<Result<string, DomainError>>;
}
import { openIndexDatabase, type OpenOutcome } from './schema.js';

export interface OpenIndexStoreOptions {
  /** Directory holding index.db (normally <workspace>/.cie, or --state-dir). */
  readonly stateDir: string;
  readonly workspaceId: WorkspaceId;
  readonly clock: Clock;
  readonly mode: 'writer' | 'follower';
  /** Lease holder id of this process (writers). */
  readonly holder: string;
  readonly confinement: StateWriteGate;
}

export interface OpenedIndexStore {
  readonly store: SqliteIndexStore;
  readonly outcome: OpenOutcome;
  readonly quarantinedAs?: string;
  close(): void;
}

export async function openIndexStore(opts: OpenIndexStoreOptions): Promise<Result<OpenedIndexStore, DomainError>> {
  const file = path.join(opts.stateDir, 'index.db');
  if (opts.mode === 'writer') {
    const allowed = await opts.confinement.check(file, 'state');
    if (!allowed.ok) return allowed;
    try {
      mkdirSync(opts.stateDir, { recursive: true });
    } catch (e) {
      return err(domainError('STATE_DIR_UNAVAILABLE', 'cannot create the state directory', { code: (e as NodeJS.ErrnoException).code }));
    }
  }
  const opened = openIndexDatabase({ file, workspaceId: opts.workspaceId, clock: opts.clock, readonly: opts.mode === 'follower' });
  if (!opened.ok) return opened;
  const { db } = opened.value;
  return ok({
    store: new SqliteIndexStore(db, opts.clock, opts.holder),
    outcome: opened.value.outcome,
    ...(opened.value.quarantinedAs === undefined ? {} : { quarantinedAs: opened.value.quarantinedAs }),
    close: () => db.close(),
  });
}
