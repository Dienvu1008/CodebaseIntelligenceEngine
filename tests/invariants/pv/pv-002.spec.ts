// PV-002: no silent promotion. Claim statuses change only along the DOMAIN_MODEL §5 transition table, every
// change records an actor, a reason and a seq, and `verified` is reachable only through ClaimVerifier: the
// VerificationToken that `markVerified` requires cannot be constructed, forged or replayed elsewhere.
// AI-002 is covered where it meets the claim aggregate: an LLM actor never changes an existing status.
import * as core from '@cie/core';
import { KnowledgeClaim, type ClaimStatus, type VerificationToken } from '@cie/core';
import { ClaimVerifier, type VerifiableClaim } from '@cie/core/verification';
import { describe, expect, it } from 'vitest';
import { code, CONCEPT, evidence, FN_A, FN_B, hasher, LLM, PRODUCER, proposed, seq, SYSTEM, unwrap, USER, userAsserted, verified, view } from '../../helpers/claims.js';

const STATUSES: readonly ClaimStatus[] = ['unknown', 'inferred', 'verified', 'user_asserted'];
const claimIn = (s: ClaimStatus): KnowledgeClaim =>
  s === 'unknown' ? proposed('unknown') : s === 'inferred' ? proposed('inferred') : s === 'verified' ? verified() : userAsserted();

/** DOMAIN_MODEL §5, transitions other than into `verified`. */
const ALLOWED = new Set(['unknown->inferred', 'inferred->unknown', 'verified->inferred', 'verified->unknown', 'user_asserted->user_asserted']);

describe('PV-002: the transition table', () => {
  it('allows exactly the DOMAIN_MODEL §5 transitions through transition()', () => {
    const allowed: string[] = [];
    for (const from of STATUSES) {
      for (const to of STATUSES.filter((t) => t !== 'verified') as Exclude<ClaimStatus, 'verified'>[]) {
        const claim = from === 'unknown' ? unwrap(claimIn(from).withEvidence([evidence('heuristic')], SYSTEM, 'evidence', seq(1))) : claimIn(from);
        const actor = from === 'user_asserted' ? USER : SYSTEM;
        const r = claim.transition(to, actor, 'table', seq(2));
        if (r.ok) allowed.push(`${from}->${to}`);
        else expect(['PV_002_TRANSITION_INVALID', 'KG_002_CLAIM_INVALID'], `${from}->${to}`).toContain(r.error.code);
      }
    }
    // user_asserted -> unknown / inferred are not in the table; implements_concept also allows them per KG-002,
    // so the refusal comes from the transition guard, not the registry.
    expect(new Set(allowed)).toEqual(ALLOWED);
  });

  it('reaches verified only from unknown, inferred or verified, and only through ClaimVerifier', () => {
    for (const from of STATUSES) {
      // Every claim gets qualifying evidence, so only the transition guard can refuse.
      const actor = from === 'user_asserted' ? USER : SYSTEM;
      const claim = unwrap(claimIn(from).withEvidence([evidence('compiler', { seq: seq(1), locator: { kind: 'source', path: 'src/c.ts' as never, range: null } })], actor, 'evidence', seq(1)));
      const r = ClaimVerifier.verify(claim, view(), PRODUCER, 'verify');
      expect(code(r), from).toBe(from === 'user_asserted' ? 'PV_002_TRANSITION_INVALID' : 'ok');
      expect(code(claim.transition('verified' as never, SYSTEM, 'shortcut', seq(2)))).toBe('PV_002_VERIFY_REQUIRES_TOKEN');
    }
  });

  it('records actor, reason and seq for every change and refuses a change without a reason', () => {
    const c = unwrap(proposed('inferred').transition('unknown', SYSTEM, 'evidence invalidated', seq(4)));
    expect(c.history).toEqual([
      { from: null, to: 'inferred', actor: 'system:cie', reason: 'test', seq: 1 },
      { from: 'inferred', to: 'unknown', actor: 'system:cie', reason: 'evidence invalidated', seq: 4 },
    ]);
    expect(code(proposed('inferred').transition('unknown', SYSTEM, '  ', seq(4)))).toBe('PV_002_REASON_REQUIRED');
    expect(code(proposed('inferred').transition('unknown', { kind: 'system', id: '' }, 'r', seq(4)))).toBe('PV_002_ACTOR_INVALID');
    expect(code(ClaimVerifier.verify(proposed('inferred', [evidence('compiler')]), view(), PRODUCER, ''))).toBe('PV_002_REASON_REQUIRED');
  });

  it('cannot propose a claim directly into verified or user_asserted', () => {
    const p = { subject: FN_A, predicate: 'calls' as const, object: FN_B, origin: { kind: 'llm' as const, id: 'qwen' }, evidence: [evidence('compiler')], actor: LLM, reason: 'r', seq: seq(1) };
    expect(code(KnowledgeClaim.propose({ ...p, status: 'verified' as never }, hasher))).toBe('PV_002_TRANSITION_INVALID');
    expect(code(KnowledgeClaim.propose({ ...p, status: 'user_asserted' as never }, hasher))).toBe('PV_002_TRANSITION_INVALID');
    expect(code(KnowledgeClaim.propose({ ...p, status: 'inferred', evidence: [] }, hasher))).toBe('CLAIM_EVIDENCE_REQUIRED');
    expect(code(KnowledgeClaim.propose({ ...p, status: 'inferred', origin: { kind: 'page', id: 'p' } }, hasher))).toBe('CLAIM_ORIGIN_INVALID');
  });

  it('keeps user assertions with their author (PV-005 groundwork)', () => {
    const u = userAsserted();
    expect(code(u.transition('user_asserted', SYSTEM, 'regenerated', seq(2)))).toBe('PV_005_USER_CLAIM_PROTECTED');
    expect(code(u.withEvidence([evidence('heuristic')], SYSTEM, 'more', seq(2)))).toBe('PV_005_USER_CLAIM_PROTECTED');
    expect(unwrap(u.transition('user_asserted', USER, 'edited the page', seq(2))).status).toBe('user_asserted');
    const a = { subject: FN_A, predicate: 'implements_concept' as const, object: CONCEPT, evidence: [], reason: 'r', seq: seq(1) };
    expect(code(KnowledgeClaim.assertByUser({ ...a, origin: { kind: 'page', id: 'p' }, actor: SYSTEM }, hasher))).toBe('PV_005_ORIGIN_REQUIRED');
  });
});

describe('PV-002 / AI-002: LLM actors', () => {
  it('may propose unknown or inferred claims, which are never verified by the proposal itself', () => {
    const p = { subject: FN_A, predicate: 'calls' as const, object: FN_B, origin: { kind: 'llm' as const, id: 'qwen' }, evidence: [evidence('llm')], actor: LLM, reason: 'model answer', seq: seq(1) };
    expect(unwrap(KnowledgeClaim.propose({ ...p, status: 'inferred' }, hasher)).status).toBe('inferred');
  });

  it('never change the status of an existing claim, nor add evidence that a verifier would accept on their word', () => {
    for (const from of STATUSES) {
      for (const to of ['unknown', 'inferred', 'user_asserted'] as const) {
        expect(code(claimIn(from).transition(to, LLM, 'model says so', seq(2))), `${from}->${to}`).toBe('AI_002_LLM_CANNOT_CHANGE_STATUS');
      }
    }
    const withLlm = unwrap(proposed('inferred').withEvidence([evidence('llm')], LLM, 'model evidence', seq(2)));
    expect(withLlm.status).toBe('inferred');
    expect(code(ClaimVerifier.verify(withLlm, view(2), PRODUCER, 'verify'))).toBe('PV_001_NO_QUALIFYING_EVIDENCE');
  });
});

describe('PV-002: the verification token', () => {
  /** Captures a genuine token by letting the verifier verify a stand-in claim. */
  function captureToken(target: KnowledgeClaim): VerificationToken {
    let captured: VerificationToken | undefined;
    const spy: VerifiableClaim<null> = {
      id: target.id,
      status: target.status,
      evidence: target.evidence,
      markVerified: (token) => {
        captured = token;
        return { ok: true, value: null };
      },
    };
    unwrap(ClaimVerifier.verify(spy, view(), PRODUCER, 'capture'));
    if (captured === undefined) throw new Error('no token');
    return captured;
  }

  it('rejects forged tokens (casts and look-alike objects)', () => {
    const claim = proposed('inferred', [evidence('compiler')]);
    const real = captureToken(claim);
    const lookalike = { claim: real.claim, evidence: real.evidence, seq: real.seq, qualifying: real.qualifying } as unknown as VerificationToken;
    const prototyped = Object.create(Object.getPrototypeOf(real) as object) as VerificationToken;
    expect(code(claim.markVerified(lookalike, PRODUCER, 'forged'))).toBe('PV_002_TOKEN_INVALID');
    expect(code(claim.markVerified(prototyped, PRODUCER, 'forged'))).toBe('PV_002_TOKEN_INVALID');
    expect(unwrap(claim.markVerified(real, PRODUCER, 'genuine')).status).toBe('verified');
    expect(Object.isFrozen(real)).toBe(true);
  });

  it('cannot be replayed on another claim or after the evidence changed', () => {
    const claim = proposed('inferred', [evidence('compiler')]);
    const token = captureToken(claim);
    const other = unwrap(KnowledgeClaim.propose({ subject: FN_B, predicate: 'calls', object: FN_A, origin: { kind: 'heuristic', id: 'h' }, status: 'inferred', evidence: [evidence('compiler')], actor: SYSTEM, reason: 'r', seq: seq(1) }, hasher));
    expect(code(other.markVerified(token, PRODUCER, 'replay'))).toBe('PV_002_TOKEN_INVALID');
    const changed = unwrap(claim.withEvidence([evidence('heuristic')], SYSTEM, 'more', seq(1)));
    expect(code(changed.markVerified(token, PRODUCER, 'stale token'))).toBe('PV_002_TOKEN_INVALID');
  });

  it('is unreachable from the main @cie/core entry and cannot be constructed (type level)', () => {
    expect('ClaimVerifier' in core).toBe(false);
    expect('VerificationToken' in core).toBe(false);
    // @ts-expect-error ClaimVerifier is not part of @cie/core (only @cie/core/verification, C8)
    expect(core.ClaimVerifier).toBeUndefined();
    const claim = proposed('inferred', [evidence('compiler')]);
    // @ts-expect-error transition() does not accept verified
    const viaTransition = () => claim.transition('verified', SYSTEM, 'r', seq(1));
    // @ts-expect-error markVerified requires a VerificationToken
    const viaObject = () => claim.markVerified({ claim: claim.id }, SYSTEM, 'r');
    // @ts-expect-error propose() accepts only unknown and inferred
    const viaPropose = () => KnowledgeClaim.propose({ subject: FN_A, predicate: 'calls', object: FN_B, origin: { kind: 'heuristic', id: 'h' }, status: 'verified', evidence: [], actor: SYSTEM, reason: 'r', seq: seq(1) }, hasher);
    expect(code(viaTransition())).toBe('PV_002_VERIFY_REQUIRES_TOKEN');
    expect(code(viaObject())).toBe('PV_002_TOKEN_INVALID');
    expect(code(viaPropose())).toBe('PV_002_TRANSITION_INVALID');
  });
});
