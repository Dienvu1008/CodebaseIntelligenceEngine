/**
 * StalenessEvaluator (DOMAIN_MODEL §6, PV-004 groundwork). Pure: it compares a claim's evidence with what
 * the revision currently holds and says whether the claim is still `current`, which evidence no longer
 * matches, and which status the claim falls back to when it can no longer stand (DOMAIN_MODEL §5):
 *
 *  - an evidence item is *changed* when its locator's target no longer exists or now has a different
 *    content hash than the one observed;
 *  - the claim is `stale` when any evidence item changed;
 *  - a `verified` claim with no qualifying evidence left (PV-001) falls back to `inferred` when unchanged
 *    non-deterministic evidence remains, and to `unknown` otherwise (PV-001 violation class DOWNGRADE);
 *  - an `inferred` claim whose evidence all changed falls back to `unknown`;
 *  - `user_asserted` claims are never downgraded by tools (PV-005); they only become stale.
 *
 * Applying the result is the claim's job (`KnowledgeClaim.applyFreshness`). Running it for every claim
 * touched by a revision, inside the publish transaction, is StalenessPropagation in Phase 05.
 */
import type { ClaimId, EvidenceId, RevisionSeq } from '../../shared-kernel/index.js';
import { isDeterministic, qualifyingEvidence, type ClaimFreshness, type ClaimStatus, type Evidence, type RevisionView } from './provenance.js';

export interface FreshnessEvaluation {
  readonly claim: ClaimId;
  readonly seq: RevisionSeq;
  readonly freshness: ClaimFreshness;
  /** Evidence ids whose target changed or disappeared, sorted. */
  readonly changed: readonly EvidenceId[];
  /** All evidence ids the evaluation looked at, sorted: applying it to a claim with other evidence is refused. */
  readonly evidence: readonly EvidenceId[];
  /** The status the claim must fall back to, or null when its status still stands. */
  readonly downgradeTo: 'inferred' | 'unknown' | null;
}

export interface EvaluableClaim {
  readonly id: ClaimId;
  readonly status: ClaimStatus;
  readonly evidence: readonly Evidence[];
}

const sortedIds = (evidence: readonly Evidence[]): EvidenceId[] => evidence.map((e) => e.id).sort();

function downgrade(claim: EvaluableClaim, unchanged: readonly Evidence[], view: RevisionView): FreshnessEvaluation['downgradeTo'] {
  if (claim.status === 'verified') {
    if (qualifyingEvidence(claim.evidence, view).length > 0) return null;
    return unchanged.some((e) => !isDeterministic(e.kind)) ? 'inferred' : 'unknown';
  }
  if (claim.status === 'inferred' && unchanged.length === 0) return 'unknown';
  return null;
}

export const StalenessEvaluator = Object.freeze({
  evaluate(claim: EvaluableClaim, view: RevisionView): FreshnessEvaluation {
    const changed = claim.evidence.filter((e) => view.currentHash(e.locator) !== e.contentHash);
    const unchanged = claim.evidence.filter((e) => !changed.includes(e));
    return Object.freeze({
      claim: claim.id,
      seq: view.seq,
      freshness: changed.length > 0 ? 'stale' : 'current',
      changed: Object.freeze(sortedIds(changed)),
      evidence: Object.freeze(sortedIds(claim.evidence)),
      downgradeTo: downgrade(claim, unchanged, view),
    });
  },
});
