// SN-005: recovery from interruption. On startup, unfinished revisions without a live lease are abandoned
// (Phase 01 policy) and never published without completed validation.
// Coverage: the decision logic, a simulated crash (the process stops mid-staging and its lease expires),
// and real kill-point crash injection: the CLI process is SIGKILLed at every pipeline stage.
import path from 'node:path';
import { planRecovery, type RevisionSeq } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLI_TEST_TIMEOUT_MS, cliWorkspace, runCli, type CliWorkspace } from '../../helpers/cli.js';

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS });
import { digestAt, file, job, publishRevision, sandbox, stageAll, type Sandbox } from '../../helpers/index-store.js';

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
    await stageAll(crashed, rev.value.seq, [file('a.ts', '9')]);
    await crashed.store.markValidating(rev.value.seq);
    crashed.close(); // the process dies before publishing
    sb.clock.advance(5_001);

    const restarted = await sb.open({ holder: 'new-process' });
    expect((await restarted.store.lease.acquire('new-process', 5_000)).ok).toBe(true);
    const plan = planRecovery({
      unfinished: await restarted.store.listUnfinished(),
      leaseHeldByOther: await restarted.store.lease.heldByOther('new-process'),
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

// ---------------------------------------------------------------------------------------------------
// Kill-point crash injection (P01-12): the real CLI process is SIGKILLed at each pipeline stage.
// ---------------------------------------------------------------------------------------------------

const STAGES = ['lease-acquired', 'recovered', 'revision-begun', 'enumerated', 'extracted', 'resolved', 'staged', 'validating', 'published'] as const;

/** The export with the revision number removed: content identity independent of how many runs happened. */
const content = (exported: string): unknown => {
  const doc = JSON.parse(exported) as Record<string, unknown>;
  delete doc['revision'];
  return doc;
};

describe('SN-005: crash injection at every pipeline stage', () => {
  let ws: CliWorkspace;
  afterEach(() => ws.dispose());

  it.each(STAGES)('recovers after a SIGKILL at "%s"', (stage) => {
    ws = cliWorkspace({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': 'export const b = 2;\n', 'package.json': '{}' });
    expect(runCli(['dev', 'index', ...ws.args()], ws.env()).code).toBe(0);
    ws.write('src/a.ts', 'export const a = 10;\n');
    ws.remove('src/b.ts');
    ws.write('src/c/d.py', 'x = 1\n');

    const killed = runCli(['dev', 'index', ...ws.args()], { ...ws.env(), CIE_TEST_HOOKS: '1', CIE_TEST_KILL_AT: stage });
    expect(killed.code === 0 && killed.signal === null, `the process should have been killed at ${stage}`).toBe(false);

    const rerun = runCli(['dev', 'index', '--json', ...ws.args()], ws.env());
    expect(rerun.code, rerun.stderr).toBe(0);
    const status = JSON.parse(runCli(['dev', 'status', '--json', ...ws.args()], ws.env()).stdout) as { unfinishedRevisions: number[]; leaseHolder: string | null };
    expect(status.unfinishedRevisions).toEqual([]);
    expect(status.leaseHolder).toBeNull();

    const recovered = runCli(['dev', 'export', ...ws.args()], ws.env());
    const clean = path.join(ws.root, 'clean-state');
    expect(runCli(['dev', 'index', ...ws.args(clean)], ws.env()).code).toBe(0);
    const reference = runCli(['dev', 'export', ...ws.args(clean)], ws.env());
    expect(content(recovered.stdout)).toEqual(content(reference.stdout));
  });
});
