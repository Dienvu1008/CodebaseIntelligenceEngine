/**
 * ClaimVerifier and its capability token (PV-001, PV-002, AI-002; DEPENDENCY_RULES C8).
 *
 * The only path to `verified`. A KnowledgeClaim moves into `verified` only through `markVerified(token)`,
 * and a VerificationToken can only be minted here, after PV-001 holds:
 *  - the constructor is private (type level) and the token carries an ECMAScript-private brand, so neither a
 *    cast nor an object literal passes `VerificationToken.isGenuine` (runtime);
 *  - the mint function is module-local and never exported;
 *  - a token names one claim, the exact evidence set it was checked against and the revision seq, so it
 *    cannot be replayed on another claim or after the evidence changed.
 *
 * Access is confined twice: this module is not re-exported from `@cie/core` (it has its own subpath,
 * `@cie/core/verification`), and dependency-cruiser allows only the knowledge context and the runtime
 * composition root to import it (FF-BND-005, FF-BND-005b). LLM-facing code never reaches it.
 *
 * It depends on the claim through the structural `VerifiableClaim` interface, so the claim aggregate can
 * import the token without an import cycle.
 */
import type { ClaimId, DomainError, EvidenceId, Result, RevisionSeq } from '../../../shared-kernel/index.js';
import { domainError, err } from '../../../shared-kernel/index.js';
import { checkActor, qualifyingEvidence, type ClaimActor, type ClaimStatus, type Evidence, type RevisionView } from '../provenance.js';

let mint: (claim: ClaimId, evidence: readonly EvidenceId[], seq: RevisionSeq, qualifying: readonly EvidenceId[]) => VerificationToken;

export class VerificationToken {
  readonly #genuine = true;

  private constructor(
    /** The claim this token may verify. */
    readonly claim: ClaimId,
    /** The claim's evidence ids at verification time, sorted: any change to the evidence voids the token. */
    readonly evidence: readonly EvidenceId[],
    readonly seq: RevisionSeq,
    /** The evidence that satisfied PV-001. */
    readonly qualifying: readonly EvidenceId[],
  ) {
    Object.freeze(this);
  }

  static {
    mint = (claim, evidence, seq, qualifying) => new VerificationToken(claim, Object.freeze([...evidence]), seq, Object.freeze([...qualifying]));
  }

  /** True only for tokens minted by ClaimVerifier (casts and look-alike objects fail). */
  static isGenuine(token: unknown): token is VerificationToken {
    return typeof token === 'object' && token !== null && #genuine in token;
  }
}

/** What the verifier needs from a claim. KnowledgeClaim satisfies it. */
export interface VerifiableClaim<C> {
  readonly id: ClaimId;
  readonly status: ClaimStatus;
  readonly evidence: readonly Evidence[];
  markVerified(token: VerificationToken, actor: ClaimActor, reason: string): Result<C, DomainError>;
}

export const evidenceIds = (evidence: readonly Evidence[]): EvidenceId[] => evidence.map((e) => e.id).sort();

export const ClaimVerifier = Object.freeze({
  /**
   * Verifies a claim against the revision: PV-001 must hold (at least one deterministic evidence item,
   * observed at or before `view.seq`, whose content still matches). LLM actors are refused (AI-002).
   */
  verify<C>(claim: VerifiableClaim<C>, view: RevisionView, actor: ClaimActor, reason: string): Result<C, DomainError> {
    const valid = checkActor(actor);
    if (!valid.ok) return valid;
    if (actor.kind === 'llm') return err(domainError('AI_002_LLM_CANNOT_VERIFY', 'an LLM actor cannot verify a claim', { claim: claim.id }));
    const qualifying = qualifyingEvidence(claim.evidence, view);
    if (qualifying.length === 0) {
      return err(domainError('PV_001_NO_QUALIFYING_EVIDENCE', `claim ${claim.id} has no deterministic evidence that matches revision ${view.seq}`, { claim: claim.id, seq: view.seq }));
    }
    const token = mint(claim.id, evidenceIds(claim.evidence), view.seq, evidenceIds(qualifying));
    return claim.markVerified(token, actor, reason);
  },
});
