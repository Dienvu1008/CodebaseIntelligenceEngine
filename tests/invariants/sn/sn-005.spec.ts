// SN-005: recovery from interruption. On startup, unfinished revisions without a live lease are abandoned
// (Phase 01 policy) and never published without completed validation.
// This file covers the decision logic and a simulated crash: the process stops mid-staging and its lease
// expires. Kill-point crash injection at every pipeline stage is added with the IndexService (P01-12).
import { planRecovery, type RevisionSeq } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestAt, file, job, publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

const s = (n: number) => n as RevisionSeq;

describe('SN-005: recovery plan', () => {
  it('abandons building and validating revisions when no other writer is alive', () => {
    expect(
      planRecovery({
        unfinished: [
          { seq: s(4), status: 'building' },
          { seq: s(5), status: 'validating' },
        ],
        leaseHeldByOther: false,
      }).map((a) => [a.kind, a.seq]),
    ).toEqual([
      ['abandon', 4],
      ['abandon', 5],
    ]);
  });

  it('touches nothing while another live writer holds the lease (followers never recover)', () => {
    expect(planRecovery({ unfinished: [{ seq: s(4), status: 'building' }], leaseHeldByOther: true })).toEqual([]);
  });

  it('never plans to publish', () => {
    const plan = planRecovery({ unfinished: [{ seq: s(4), status: 'validating' }], leaseHeldByOther: false });
    expect(plan.every((a) => a.kind === 'abandon')).toBe(true);
  });
});

describe('SN-005: simulated crash mid-staging', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox();
  });
  afterEach(() => sb.dispose());

  it('restarts to exactly the last published state', async () => {
    const crashed = await sb.open({ holder: 'old-process' });
    await crashed.store.lease.acquire('old-process', 5_000);
    const s1 = await publishRevision(crashed, [file('a.ts', 'a'), file('b.ts', 'b')]);
    const before = await digestAt(crashed, s1);
    const rev = await crashed.store.begin(s1, job('crashing'));
    if (!rev.ok) throw new Error(rev.error.code);
    await crashed.store.stageManifest(rev.value.seq, [file('a.ts', '9')]);
    await crashed.store.markValidating(rev.value.seq);
    crashed.close(); // the process dies before publishing
    sb.clock.advance(5_001);

    const restarted = await sb.open({ holder: 'new-process' });
    expect((await restarted.store.lease.acquire('new-process', 5_000)).ok).toBe(true);
    const plan = planRecovery({
      unfinished: await restarted.store.listUnfinished(),
      leaseHeldByOther: restarted.store.lease.heldByOther('new-process'),
    });
    for (const step of plan) expect((await restarted.store.abandon(step.seq, step.reason)).ok).toBe(true);

    expect((await restarted.store.head())?.seq).toBe(s1);
    expect(await digestAt(restarted, s1)).toBe(before);
    expect(await restarted.store.listUnfinished()).toEqual([]);
    expect((await restarted.store.get(rev.value.seq))?.status).toBe('abandoned');
    // Recovery must leave a store that keeps working: the next revision still contains b.ts unchanged.
    const next = await publishRevision(restarted, [file('a.ts', 'a'), file('b.ts', 'b')]);
    expect(await digestAt(restarted, next)).toBe(before);
  });
});
