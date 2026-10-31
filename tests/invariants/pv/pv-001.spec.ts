// PV-001: verified requires deterministic evidence. A claim becomes `verified` at seq S only if at least one
// evidence item (a) has a deterministic kind (filesystem, ast, compiler, scip, lsp), (b) was observed at a
// seq <= S and (c) still matches the current content hash of its locator at S. ClaimVerifier is the
// enforcement point; `qualifyingEvidence` is the single definition it shares with the RevisionValidator.
import { DETERMINISTIC_EVIDENCE_KINDS, EVIDENCE_KINDS, qualifyingEvidence, type EvidenceKind } from '@cie/core';
import { ClaimVerifier } from '@cie/core/verification';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { code, evidence, hash, LLM, PRODUCER, proposed, seq, unwrap, view } from '../../helpers/claims.js';

describe('PV-001: ClaimVerifier', () => {
  it('verifies an inferred claim backed by matching compiler evidence and records the transition', () => {
    const claim = proposed('inferred', [evidence('heuristic'), evidence('compiler')]);
    const v = unwrap(ClaimVerifier.verify(claim, view(2), PRODUCER, 'lang-ts resolved the call'));
    expect(v.status).toBe('verified');
    expect(v.freshness).toBe('current');
    expect(v.id).toBe(claim.id);
    expect(v.history.at(-1)).toEqual({ from: 'inferred', to: 'verified', actor: 'producer:lang-ts', reason: 'lang-ts resolved the call', seq: 2 });
    expect(claim.status).toBe('inferred'); // immutable: the original claim is unchanged
  });

  it('verifies an unknown claim once deterministic evidence is attached', () => {
    const claim = unwrap(proposed('unknown').withEvidence([evidence('ast')], PRODUCER, 'parser saw the call', seq(1)));
    expect(unwrap(ClaimVerifier.verify(claim, view(), PRODUCER, 'ok')).status).toBe('verified');
  });

  it.each([
    ['only heuristic and LLM evidence', () => proposed('inferred', [evidence('heuristic'), evidence('llm')]), view()],
    ['deterministic evidence whose file changed since', () => proposed('inferred', [evidence('compiler')]), view(2, { 'src/a.ts': 'v2' })],
    ['deterministic evidence whose file was deleted', () => proposed('inferred', [evidence('compiler')]), view(2, { 'src/a.ts': null })],
    ['deterministic evidence from a later revision', () => proposed('inferred', [evidence('compiler', { seq: seq(5) })]), view(4)],
    ['no evidence at all', () => proposed('unknown'), view()],
  ])('refuses a claim with %s', (_label, build, at) => {
    const r = ClaimVerifier.verify(build(), at, PRODUCER, 'try');
    expect(code(r)).toBe('PV_001_NO_QUALIFYING_EVIDENCE');
  });

  it('re-verification returns a verified claim to current after its evidence was refreshed', () => {
    const v = unwrap(ClaimVerifier.verify(proposed('inferred', [evidence('compiler')]), view(1), PRODUCER, 'first'));
    const fresh = unwrap(v.withEvidence([evidence('compiler', { seq: seq(2), contentHash: hash('v2') })], PRODUCER, 'file changed', seq(2)));
    const again = unwrap(ClaimVerifier.verify(fresh, view(2, { 'src/a.ts': 'v2' }), PRODUCER, 're-verified'));
    expect(again.history.map((t) => `${t.from}->${t.to}`)).toEqual(['null->inferred', 'inferred->verified', 'verified->verified', 'verified->verified']);
  });

  it('refuses an LLM actor even with qualifying evidence (AI-002)', () => {
    expect(code(ClaimVerifier.verify(proposed('inferred', [evidence('compiler')]), view(), LLM, 'trust me'))).toBe('AI_002_LLM_CANNOT_VERIFY');
  });
});

describe('PV-001: qualifying evidence', () => {
  it('accepts exactly the deterministic kinds', () => {
    expect(DETERMINISTIC_EVIDENCE_KINDS).toEqual(['filesystem', 'ast', 'compiler', 'scip', 'lsp']);
    const kinds = EVIDENCE_KINDS.filter((k) => k !== 'llm' && k !== 'user');
    const q = qualifyingEvidence(kinds.map((k) => evidence(k)), view());
    expect(q.map((e) => e.kind).sort()).toEqual([...DETERMINISTIC_EVIDENCE_KINDS].sort());
  });

  it('verification succeeds exactly when some evidence qualifies (property-based)', () => {
    const item = fc.record({
      kind: fc.constantFrom<EvidenceKind>('filesystem', 'ast', 'compiler', 'scip', 'lsp', 'heuristic'),
      seenAt: fc.integer({ min: 1, max: 4 }),
      content: fc.constantFrom('v1', 'v2'),
      file: fc.constantFrom('src/a.ts', 'src/b.ts'),
      line: fc.nat(3),
    });
    fc.assert(
      fc.property(fc.uniqueArray(item, { minLength: 1, maxLength: 5, selector: (i) => `${i.kind}|${i.content}|${i.file}|${i.line}` }), fc.integer({ min: 1, max: 4 }), (items, at) => {
        const ev = items.map((i) => evidence(i.kind, { seq: seq(i.seenAt), contentHash: hash(i.content), locator: { kind: 'source', path: i.file as never, range: { startLine: i.line, startCol: 0, endLine: i.line, endCol: 1 } } }));
        const current = view(at, { 'src/a.ts': 'v1', 'src/b.ts': 'v2' });
        const expected = items.some((i) => i.kind !== 'heuristic' && i.seenAt <= at && i.content === (i.file === 'src/a.ts' ? 'v1' : 'v2'));
        const r = ClaimVerifier.verify(proposed('inferred', ev), current, PRODUCER, 'property');
        expect(r.ok).toBe(expected);
      }),
      { numRuns: 300 },
    );
  });
});
