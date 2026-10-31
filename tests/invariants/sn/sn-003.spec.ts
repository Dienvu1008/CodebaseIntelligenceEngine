// SN-003: atomic visibility. No query observes rows introduced or closed by revision N unless N is
// published; publishing N makes all of its rows visible in one transaction.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cseq, stageAll, digestAt, file, job, publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

describe('SN-003: staging is invisible to readers', () => {
  it('a concurrent read-only follower keeps seeing the head while a revision is staged, then sees all of it at once', async () => {
    const writer = await sb.open();
    await writer.store.lease.acquire('writer-1', 60_000);
    const s1 = await publishRevision(writer, [file('a.ts', 'a'), file('b.ts', 'b'), file('c.ts', 'c')]);
    const follower = await sb.open({ mode: 'follower', holder: 'follower-1' });
    const before = await digestAt(follower, s1);

    const rev = await writer.store.begin(s1, job('j2'));
    if (!rev.ok) throw new Error(rev.error.code);
    // Change a.ts, delete b.ts, add d.ts: introductions and closures at the same time.
    await stageAll(writer, rev.value.seq, [file('a.ts', 'f'), file('c.ts', 'c'), file('d.ts', 'd')]);
    await writer.store.markValidating(rev.value.seq);

    expect((await follower.store.head())?.seq).toBe(s1);
    expect(await digestAt(follower, s1)).toBe(before);
    const staged = await follower.store.filesAt(rev.value.seq);
    expect(staged.ok === false && staged.error.code).toBe('REVISION_NOT_VISIBLE');

    expect((await writer.store.publish(rev.value.seq, cseq(0))).ok).toBe(true);
    expect((await follower.store.head())?.seq).toBe(rev.value.seq);
    const after = await follower.store.filesAt(rev.value.seq);
    if (!after.ok) throw new Error(after.error.code);
    expect(after.value.map((e) => [e.path, e.status === 'indexed' ? e.hash.slice(7, 8) : '-'])).toEqual([
      ['a.ts', 'f'],
      ['c.ts', 'c'],
      ['d.ts', 'd'],
    ]);
  });

  it('abandoning a staged revision restores the exact previous state', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const s1 = await publishRevision(o, [file('a.ts', 'a'), file('b.ts', 'b')]);
    const before = await digestAt(o, s1);
    const rev = await o.store.begin(s1, job('j2'));
    if (!rev.ok) throw new Error(rev.error.code);
    await o.store.stageManifest(rev.value.seq, [file('a.ts', 'e')]);
    expect((await o.store.abandon(rev.value.seq, 'test')).ok).toBe(true);
    expect(await digestAt(o, s1)).toBe(before);
    expect((await o.store.get(rev.value.seq))?.status).toBe('abandoned');
    // The next revision gets a fresh seq; abandoned seqs are never reused.
    const s3 = await publishRevision(o, [file('a.ts', 'a'), file('b.ts', 'b')]);
    expect(s3).toBe(rev.value.seq + 1);
    // ...and it must contain the unchanged files. If abandon failed to re-open the rows it had closed,
    // they would survive with valid_to = the abandoned seq and silently vanish from every later revision.
    expect(await digestAt(o, s3)).toBe(before);
  });

  it('refuses to read an abandoned seq', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const rev = await o.store.begin(null, job('j1'));
    if (!rev.ok) throw new Error(rev.error.code);
    await o.store.abandon(rev.value.seq, 'test');
    const r = await o.store.filesAt(rev.value.seq);
    expect(r.ok === false && r.error.code).toBe('REVISION_NOT_VISIBLE');
  });
});
