// StalenessEvaluator (P03-06, PV-004 groundwork): evidence content hashes against the current revision,
// and how a claim applies the result. Full propagation on change is Phase 05 (StalenessPropagation).
import { StalenessEvaluator, type KnowledgeClaim } from '@cie/core';
import { ClaimVerifier } from '@cie/core/verification';
import { describe, expect, it } from 'vitest';
import { code, evidence, hash, LLM, PRODUCER, proposed, seq, source, SYSTEM, unwrap, USER, userAsserted, view } from '../../../tests/helpers/claims.js';

const verify = (c: KnowledgeClaim, at = view()) => unwrap(ClaimVerifier.verify(c, at, PRODUCER, 'verify'));

describe('StalenessEvaluator.evaluate', () => {
  it('is current while every evidence target still has the observed content', () => {
    const c = proposed('inferred', [evidence('heuristic'), evidence('compiler')]);
    expect(StalenessEvaluator.evaluate(c, view(2))).toMatchObject({ claim: c.id, seq: 2, freshness: 'current', changed: [], downgradeTo: null });
  });

  it('is stale when a target changed or disappeared, and lists exactly those evidence items', () => {
    const a = evidence('compiler');
    const b = evidence('ast', { locator: source('src/b.ts') });
    const c = verify(proposed('inferred', [a, b]));
    expect(StalenessEvaluator.evaluate(c, view(2, { 'src/a.ts': 'v2' }))).toMatchObject({ freshness: 'stale', changed: [a.id], downgradeTo: null });
    expect(StalenessEvaluator.evaluate(c, view(2, { 'src/b.ts': null })).changed).toEqual([b.id]);
    expect(StalenessEvaluator.evaluate(c, view(2, { 'src/a.ts': 'v2', 'src/b.ts': null })).changed).toEqual([a.id, b.id].sort());
  });

  it('downgrades a verified claim that lost all qualifying evidence: to inferred if heuristic or AI evidence remains, else unknown', () => {
    const det = evidence('compiler');
    const heur = evidence('heuristic', { locator: source('src/b.ts') });
    expect(StalenessEvaluator.evaluate(verify(proposed('inferred', [det, heur])), view(2, { 'src/a.ts': 'v2' })).downgradeTo).toBe('inferred');
    expect(StalenessEvaluator.evaluate(verify(proposed('inferred', [det])), view(2, { 'src/a.ts': 'v2' })).downgradeTo).toBe('unknown');
    // heuristic evidence that changed as well does not hold the claim up
    expect(StalenessEvaluator.evaluate(verify(proposed('inferred', [det, heur])), view(2, { 'src/a.ts': 'v2', 'src/b.ts': 'v2' })).downgradeTo).toBe('unknown');
  });

  it('downgrades an inferred claim only when all of its evidence changed', () => {
    const c = proposed('inferred', [evidence('heuristic'), evidence('heuristic', { locator: source('src/b.ts') })]);
    expect(StalenessEvaluator.evaluate(c, view(2, { 'src/a.ts': 'v2' })).downgradeTo).toBeNull();
    expect(StalenessEvaluator.evaluate(c, view(2, { 'src/a.ts': 'v2', 'src/b.ts': 'v2' })).downgradeTo).toBe('unknown');
  });

  it('never downgrades a user assertion (PV-005); it only becomes stale', () => {
    const u = unwrap(userAsserted().withEvidence([evidence('ast')], USER, 'cites code', seq(1)));
    expect(StalenessEvaluator.evaluate(u, view(2, { 'src/a.ts': 'v2' }))).toMatchObject({ freshness: 'stale', downgradeTo: null });
  });

  it('is deterministic and frozen', () => {
    const c = proposed('inferred', [evidence('heuristic', { locator: source('src/b.ts') }), evidence('heuristic')]);
    const e = StalenessEvaluator.evaluate(c, view(2, { 'src/a.ts': 'v2', 'src/b.ts': 'v2' }));
    expect(e).toEqual(StalenessEvaluator.evaluate(c, view(2, { 'src/a.ts': 'v2', 'src/b.ts': 'v2' })));
    expect(e.changed).toEqual([...e.changed].sort());
    expect(Object.isFrozen(e) && Object.isFrozen(e.changed)).toBe(true);
  });
});

describe('KnowledgeClaim.applyFreshness', () => {
  it('marks a claim stale and back to current when its evidence matches again (non-verified claims)', () => {
    const c = proposed('inferred', [evidence('heuristic'), evidence('heuristic', { locator: source('src/b.ts') })]);
    const stale = unwrap(c.applyFreshness(StalenessEvaluator.evaluate(c, view(2, { 'src/a.ts': 'v2' })), SYSTEM, 'a.ts changed'));
    expect([stale.status, stale.freshness]).toEqual(['inferred', 'stale']);
    expect(stale.history).toHaveLength(1); // freshness is not a status transition
    const back = unwrap(stale.applyFreshness(StalenessEvaluator.evaluate(stale, view(3)), SYSTEM, 'a.ts reverted'));
    expect(back.freshness).toBe('current');
  });

  it('applies the fallback status as a recorded transition', () => {
    const c = verify(proposed('inferred', [evidence('compiler')]));
    const down = unwrap(c.applyFreshness(StalenessEvaluator.evaluate(c, view(2, { 'src/a.ts': 'v2' })), SYSTEM, 'a.ts changed'));
    expect([down.status, down.freshness]).toEqual(['unknown', 'stale']);
    expect(down.history.at(-1)).toEqual({ from: 'verified', to: 'unknown', actor: 'system:cie', reason: 'a.ts changed', seq: 2 });
  });

  it('never reports a stale verified claim as current without re-verification (PV-004)', () => {
    const det = evidence('compiler');
    const other = evidence('ast', { locator: source('src/b.ts') });
    const c = verify(proposed('inferred', [det, other]));
    const stale = unwrap(c.applyFreshness(StalenessEvaluator.evaluate(c, view(2, { 'src/b.ts': 'v2' })), SYSTEM, 'b.ts changed'));
    expect([stale.status, stale.freshness]).toEqual(['verified', 'stale']);
    expect(code(stale.applyFreshness(StalenessEvaluator.evaluate(stale, view(3)), SYSTEM, 'b.ts reverted'))).toBe('CLAIM_REVERIFY_REQUIRED');
    const refreshed = unwrap(stale.withEvidence([evidence('ast', { seq: seq(3), contentHash: hash('v2'), locator: source('src/b.ts') })], PRODUCER, 'new parse', seq(3)));
    expect(verify(refreshed, view(3, { 'src/b.ts': 'v2' })).freshness).toBe('current');
  });

  it('refuses an evaluation of another claim or evidence set, and LLM actors', () => {
    const c = proposed('inferred');
    const other = proposed('inferred', [evidence('heuristic', { locator: source('src/b.ts') })]);
    expect(code(c.applyFreshness(StalenessEvaluator.evaluate(other, view(2)), SYSTEM, 'r'))).toBe('CLAIM_EVALUATION_MISMATCH');
    const grown = unwrap(c.withEvidence([evidence('heuristic', { locator: source('src/c.ts') })], SYSTEM, 'more', seq(1)));
    expect(code(grown.applyFreshness(StalenessEvaluator.evaluate(c, view(2)), SYSTEM, 'r'))).toBe('CLAIM_EVALUATION_MISMATCH');
    expect(code(c.applyFreshness(StalenessEvaluator.evaluate(c, view(2)), LLM, 'r'))).toBe('AI_002_LLM_CANNOT_CHANGE_STATUS');
  });
});
