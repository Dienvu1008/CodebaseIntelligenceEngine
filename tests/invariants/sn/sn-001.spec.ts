// SN-001: "current" means fully processed.
//  - publish requires watermark >= the max seq of the change set the revision was built from;
//  - freshness is current iff a published head exists and no relevant change lies beyond its watermark.
// The change log itself arrives with the IndexService (P01-09) and the watcher (Phase 05). This file pins
// the domain rules, plus the store recording the published watermark.
import { decidePublish, evaluateFreshness, type RevisionSeq } from '@cie/core';
import { afterEach, describe, expect, it } from 'vitest';
import { cseq, file, publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

const seq = (n: number) => n as RevisionSeq;
const candidate = (watermark: number) => ({ seq: seq(2), baseSeq: seq(1), status: 'validating' as const, watermark: cseq(watermark) });

describe('SN-001: publish requires a complete watermark', () => {
  it('refuses a revision whose watermark is behind its source change set', () => {
    const r = decidePublish({ candidate: candidate(9), headSeq: seq(1), sourceMaxChangeSeq: cseq(10), violations: [] });
    expect(r.ok === false && r.error.code).toBe('PUBLISH_WATERMARK_BEHIND');
  });
  it('accepts a revision whose watermark covers its source change set', () => {
    expect(decidePublish({ candidate: candidate(10), headSeq: seq(1), sourceMaxChangeSeq: cseq(10), violations: [] }).ok).toBe(true);
  });
  it.each(['building', 'published', 'abandoned'] as const)('refuses to publish a revision in status %s', (status) => {
    const r = decidePublish({ candidate: { ...candidate(10), status }, headSeq: seq(1), sourceMaxChangeSeq: cseq(10), violations: [] });
    expect(r.ok === false && r.error.code).toBe('PUBLISH_NOT_VALIDATED');
  });
});

describe('SN-001: freshness', () => {
  it.each([
    [null, null, 'reliable', 'unknown'], // nothing published yet
    [5, null, 'reliable', 'current'],
    [5, 5, 'reliable', 'current'],
    [5, 6, 'reliable', 'stale'], // a relevant change is not processed yet
    [5, 3, 'degraded', 'unknown'], // watcher degraded: never claim current
  ] as const)('head watermark %s, latest change %s, tracking %s gives %s', (head, latest, tracking, expected) => {
    expect(
      evaluateFreshness({
        headWatermark: head === null ? null : cseq(head),
        latestRelevantChangeSeq: latest === null ? null : cseq(latest),
        changeTracking: tracking,
      }),
    ).toBe(expected);
  });
});

describe('SN-001: the store records the published watermark', () => {
  let sb: Sandbox;
  afterEach(() => sb.dispose());
  it('exposes the watermark of the head revision', async () => {
    sb = await sandbox();
    const o = await sb.open();
    expect((await o.store.lease.acquire('writer-1', 60_000)).ok).toBe(true);
    await publishRevision(o, [file('a.ts', 'a')], 42);
    expect(await o.store.head()).toEqual({ seq: 1, watermark: 42 });
  });
});
