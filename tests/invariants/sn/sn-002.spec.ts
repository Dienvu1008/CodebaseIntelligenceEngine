// SN-002: no silent overwrite. publish(R) succeeds iff head.seq = R.baseSeq at commit time; otherwise it
// fails with PUBLISH_CONFLICT and changes nothing.
import path from 'node:path';
import Database from 'better-sqlite3';
import { decidePublish, type RevisionSeq } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cseq, stageAll, file, job, publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

describe('SN-002: compare-and-swap publish', () => {
  it('domain policy rejects a stale base', () => {
    const r = decidePublish({
      candidate: { seq: 3 as RevisionSeq, baseSeq: 1 as RevisionSeq, status: 'validating', watermark: cseq(0) },
      headSeq: 2 as RevisionSeq,
      sourceMaxChangeSeq: cseq(0),
      violations: [],
    });
    expect(r.ok === false && r.error.code).toBe('PUBLISH_CONFLICT');
  });

  it('refuses to begin a revision on a base that is not the head', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    await publishRevision(o, [file('a.ts', 'a')]);
    const r = await o.store.begin(null, job('stale'));
    expect(r.ok === false && r.error.code).toBe('PUBLISH_CONFLICT');
  });

  it('fails with PUBLISH_CONFLICT, and changes nothing, if the head moves between staging and publish', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const first = await publishRevision(o, [file('a.ts', 'a')]);
    const rev = await o.store.begin(first, job('j2'));
    if (!rev.ok) throw new Error(rev.error.code);
    await stageAll(o, rev.value.seq, [file('a.ts', 'b')]);
    await o.store.markValidating(rev.value.seq);

    // Another process moves the head behind this writer's back (simulated with a second connection).
    const other = new Database(path.join(sb.stateDir, 'index.db'));
    other.prepare('update workspace_head set current_seq = 99 where id = 1').run();
    other.close();

    const r = await o.store.publish(rev.value.seq, cseq(0));
    expect(r.ok === false && r.error.code).toBe('PUBLISH_CONFLICT');
    expect((await o.store.head())?.seq).toBe(99); // untouched by the failed publish
    expect((await o.store.get(rev.value.seq))?.status).toBe('validating'); // not marked published
  });

  it('refuses to start a second staging revision while one is in progress', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    expect((await o.store.begin(null, job('j1'))).ok).toBe(true);
    const second = await o.store.begin(null, job('j2'));
    expect(second.ok === false && second.error.code).toBe('STAGING_IN_PROGRESS');
  });
});
