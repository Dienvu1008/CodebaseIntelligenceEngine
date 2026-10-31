// SN-004: single writer. At most one job holds a valid write lease; staging writes require it; an expired
// lease can be taken over, and the takeover abandons the previous holder's staging (via recovery, SN-005).
import { planRecovery } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { file, job, sandbox, type Sandbox } from '../../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

describe('SN-004: single-writer lease', () => {
  it('gives the lease to one writer and answers CIE_BUSY to the next', async () => {
    const a = await sb.open({ holder: 'A' });
    const b = await sb.open({ holder: 'B' });
    expect((await a.store.lease.acquire('A', 10_000)).ok).toBe(true);
    const r = await b.store.lease.acquire('B', 10_000);
    expect(r.ok === false && r.error.code).toBe('CIE_BUSY');
  });

  it('refuses every write without a live lease', async () => {
    const a = await sb.open({ holder: 'A' });
    const r = await a.store.begin(null, job('j'));
    expect(r.ok === false && r.error.code).toBe('LEASE_NOT_HELD');
  });

  it('lets a new writer take over an expired lease, and locks out the old one', async () => {
    const a = await sb.open({ holder: 'A' });
    const b = await sb.open({ holder: 'B' });
    await a.store.lease.acquire('A', 10_000);
    const rev = await a.store.begin(null, job('ja'));
    if (!rev.ok) throw new Error(rev.error.code);

    sb.clock.advance(10_001); // A stalls, and its lease expires
    expect((await b.store.lease.acquire('B', 10_000)).ok).toBe(true);

    // A cannot keep writing: neither staging nor renewing works any more.
    const stage = await a.store.stageManifest(rev.value.seq, [file('a.ts', 'a')]);
    expect(stage.ok === false && stage.error.code).toBe('LEASE_NOT_HELD');
    const renew = await a.store.lease.renew({ holder: 'A', expiresAtMs: 0 }, 10_000);
    expect(renew.ok === false && renew.error.code).toBe('LEASE_LOST');

    // B's recovery abandons A's unfinished staging revision.
    const plan = planRecovery({ unfinished: await b.store.listUnfinished(), leaseHeldByOther: await b.store.lease.heldByOther('B') });
    expect(plan).toEqual([{ kind: 'abandon', seq: rev.value.seq, reason: 'interrupted while building (SN-005)' }]);
    for (const step of plan) expect((await b.store.abandon(step.seq, step.reason)).ok).toBe(true);
    expect((await b.store.begin(null, job('jb'))).ok).toBe(true);
  });

  it('lets a holder re-acquire and renew its own lease, and release it', async () => {
    const a = await sb.open({ holder: 'A' });
    const lease = await a.store.lease.acquire('A', 1_000);
    expect((await a.store.lease.acquire('A', 1_000)).ok).toBe(true);
    if (!lease.ok) throw new Error('lease');
    expect((await a.store.lease.renew(lease.value, 5_000)).ok).toBe(true);
    await a.store.lease.release(lease.value);
    const b = await sb.open({ holder: 'B' });
    expect((await b.store.lease.acquire('B', 1_000)).ok).toBe(true);
  });
});
