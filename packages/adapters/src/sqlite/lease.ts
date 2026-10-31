/**
 * Single-writer lease (SN-004), backed by the one-row index_lease table and compare-and-swap updates.
 * An expired lease can be taken over. Abandoning the previous holder's staging revision is the caller's
 * job: IndexService runs RecoveryService right after acquiring.
 */
import type Database from 'better-sqlite3';
import { domainError, err, ok, type Clock, type DomainError, type Lease, type LeaseManager, type Result } from '@cie/core';

export class SqliteLeaseManager implements LeaseManager {
  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
  ) {}

  /** Synchronous check used inside write transactions: does `holder` own a live lease right now? */
  holds(holder: string): boolean {
    const row = this.current();
    return row.holder === holder && row.expires_at_ms > this.clock.nowMs();
  }

  /** True when a different holder owns a live lease. */
  async heldByOther(holder: string): Promise<boolean> {
    const row = this.current();
    return row.holder !== null && row.holder !== holder && row.expires_at_ms > this.clock.nowMs();
  }

  /** The current holder id, or null. For diagnostics and stale-holder detection in the composition root. */
  currentHolder(): string | null {
    return this.current().holder;
  }

  /**
   * Releases a lease held by `holder` regardless of expiry. Used only by the composition root after it has
   * proven that holder's process is dead on this machine (crash recovery without waiting for the TTL).
   * Compare-and-swap: if anybody else took the lease meanwhile, nothing happens.
   */
  breakStaleLease(holder: string): boolean {
    return this.db.prepare('update index_lease set holder = null, expires_at_ms = 0 where id = 1 and holder = ?').run(holder).changes === 1;
  }

  private current(): { holder: string | null; expires_at_ms: number } {
    return this.db.prepare('select holder, expires_at_ms from index_lease where id = 1').get() as { holder: string | null; expires_at_ms: number };
  }

  async acquire(holder: string, ttlMs: number): Promise<Result<Lease, DomainError>> {
    const now = this.clock.nowMs();
    const expiresAtMs = now + ttlMs;
    const changed = this.db
      .prepare('update index_lease set holder = ?, expires_at_ms = ? where id = 1 and (holder is null or expires_at_ms <= ? or holder = ?)')
      .run(holder, expiresAtMs, now, holder).changes;
    return changed === 1
      ? ok({ holder, expiresAtMs })
      : err(domainError('CIE_BUSY', 'another writer holds the index lease (SN-004)'));
  }

  async renew(lease: Lease, ttlMs: number): Promise<Result<Lease, DomainError>> {
    const now = this.clock.nowMs();
    const expiresAtMs = now + ttlMs;
    const changed = this.db
      .prepare('update index_lease set expires_at_ms = ? where id = 1 and holder = ? and expires_at_ms > ?')
      .run(expiresAtMs, lease.holder, now).changes;
    return changed === 1
      ? ok({ holder: lease.holder, expiresAtMs })
      : err(domainError('LEASE_LOST', 'the lease expired or was taken over'));
  }

  async release(lease: Lease): Promise<void> {
    this.db.prepare('update index_lease set holder = null, expires_at_ms = 0 where id = 1 and holder = ?').run(lease.holder);
  }
}
