// SN-007: published revisions are immutable. The set of rows visible at a published revision P never
// changes while P is retained, whatever later revisions publish or abandon.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { digestAt, file, job, publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

describe('SN-007: immutability of published revisions', () => {
  it('keeps every earlier revision byte-identical across changes, deletions, additions and an abandon', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const r1 = await publishRevision(o, [file('a.ts', 'a'), file('b.ts', 'b'), file('c.ts', 'c')]);
    const d1 = await digestAt(o, r1);

    const r2 = await publishRevision(o, [file('a.ts', '1'), file('c.ts', 'c'), file('d.ts', 'd')]); // change, delete, add
    const d2 = await digestAt(o, r2);
    expect(d2).not.toBe(d1);

    const r3 = await publishRevision(o, [file('a.ts', 'a'), file('c.ts', 'c')]); // revert a.ts, delete d.ts
    const aborted = await o.store.begin(r3, job('aborted'));
    if (!aborted.ok) throw new Error(aborted.error.code);
    await o.store.stageManifest(aborted.value.seq, []); // would delete everything
    await o.store.abandon(aborted.value.seq, 'test');

    expect(await digestAt(o, r1)).toBe(d1);
    expect(await digestAt(o, r2)).toBe(d2);
    expect((await o.store.get(r1))?.status).toBe('superseded');
    expect((await o.store.get(r3))?.status).toBe('published');
  });

  it('does not create new row versions for unchanged files', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const r1 = await publishRevision(o, [file('a.ts', 'a'), file('b.ts', 'b')]);
    const rev = await o.store.begin(r1, job('j2'));
    if (!rev.ok) throw new Error(rev.error.code);
    expect(await o.store.stageManifest(rev.value.seq, [file('a.ts', 'a'), file('b.ts', '2')])).toEqual({
      ok: true,
      value: { inserted: 1, closed: 1, unchanged: 1 },
    });
  });
});
