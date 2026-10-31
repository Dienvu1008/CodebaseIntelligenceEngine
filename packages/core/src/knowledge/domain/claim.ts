/**
 * KnowledgeClaim aggregate (DOMAIN_MODEL §5): a semantic relation `subject —predicate→ object` with its
 * status, freshness, explicit evidence and transition history. Immutable: every change returns a new claim.
 *
 *  - KG-002: the predicate is a registered relation type, its signature admits (subject kind, object kind)
 *    and the status is allowed for it, at creation and after every transition.
 *  - PV-002: statuses change only along the transition table below, every change records an actor, a reason
 *    and the seq, and `verified` is reachable only through `markVerified` with a VerificationToken, which
 *    only ClaimVerifier can mint.
 *  - AI-002: an LLM actor can propose `unknown` or `inferred` claims but never changes an existing status.
 *  - PV-005 (groundwork for Phase 04): `user_asserted` claims originate from a page.
 *
 * Attribute claims (an object value instead of a node) arrive with the phases that produce them.
 */
import type { ClaimId, DomainError, Hasher, Result, RevisionSeq } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import {
  checkActor,
  checkOrigin,
  claimId,
  formatActor,
  type ClaimActor,
  type ClaimNode,
  type ClaimOrigin,
  type ClaimStatus,
  type Evidence,
  type ClaimFreshness,
} from './provenance.js';
import { relationViolations, type RelationTypeName } from './relation-type.js';
import { evidenceIds, VerificationToken } from './verification/claim-verifier.js';

export interface ClaimTransition {
  readonly from: ClaimStatus | null;
  readonly to: ClaimStatus;
  readonly actor: string;
  readonly reason: string;
  readonly seq: RevisionSeq;
}

/** Status changes other than into `verified` (DOMAIN_MODEL §5). `verified` is reached only by ClaimVerifier. */
const TRANSITIONS: Readonly<Record<ClaimStatus, readonly ClaimStatus[]>> = {
  unknown: ['inferred'],
  inferred: ['unknown'],
  verified: ['inferred', 'unknown'],
  user_asserted: ['user_asserted'],
};
/**
 * Statuses from which ClaimVerifier may verify. `verified → verified` is re-verification: it returns a
 * stale claim to `current` (DOMAIN_MODEL §5, PV-004). User assertions are never verified by tools (PV-005).
 */
const VERIFIABLE_FROM: readonly ClaimStatus[] = ['unknown', 'inferred', 'verified'];

export type ProposedStatus = 'unknown' | 'inferred';

export interface ClaimProposal {
  readonly subject: ClaimNode;
  readonly predicate: RelationTypeName;
  readonly object: ClaimNode;
  readonly origin: ClaimOrigin;
  readonly status: ProposedStatus;
  readonly evidence: readonly Evidence[];
  readonly actor: ClaimActor;
  readonly reason: string;
  readonly seq: RevisionSeq;
}

export interface UserAssertion extends Omit<ClaimProposal, 'status' | 'origin'> {
  readonly origin: ClaimOrigin & { readonly kind: 'page' };
}

interface ClaimState {
  readonly id: ClaimId;
  readonly subject: ClaimNode;
  readonly predicate: RelationTypeName;
  readonly object: ClaimNode;
  readonly origin: ClaimOrigin;
  readonly status: ClaimStatus;
  readonly freshness: ClaimFreshness;
  readonly evidence: readonly Evidence[];
  readonly history: readonly ClaimTransition[];
}

const fail = (code: string, message: string, details?: Readonly<Record<string, unknown>>): Result<never, DomainError> => err(domainError(code, message, details));

function checkChange(actor: ClaimActor, reason: string): Result<true, DomainError> {
  const a = checkActor(actor);
  if (!a.ok) return a;
  if (reason.trim() === '') return fail('PV_002_REASON_REQUIRED', 'every claim transition records a reason');
  return ok(true);
}

function checkRelation(s: Pick<ClaimState, 'subject' | 'predicate' | 'object' | 'status'>): Result<true, DomainError> {
  const v = relationViolations({ type: s.predicate, fromKind: s.subject.kind, toKind: s.object.kind, status: s.status });
  return v.length === 0 ? ok(true) : fail('KG_002_CLAIM_INVALID', v.join('; '), { violations: [...v] });
}

function uniqueEvidence(evidence: readonly Evidence[]): Result<readonly Evidence[], DomainError> {
  const ids = new Set<string>();
  for (const e of evidence) {
    if (ids.has(e.id)) return fail('CLAIM_EVIDENCE_DUPLICATE', `evidence ${e.id} is listed twice`);
    ids.add(e.id);
  }
  return ok(Object.freeze([...evidence].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))));
}

export class KnowledgeClaim {
  private constructor(private readonly state: ClaimState) {
    Object.freeze(this);
  }

  get id(): ClaimId {
    return this.state.id;
  }
  get subject(): ClaimNode {
    return this.state.subject;
  }
  get predicate(): RelationTypeName {
    return this.state.predicate;
  }
  get object(): ClaimNode {
    return this.state.object;
  }
  get origin(): ClaimOrigin {
    return this.state.origin;
  }
  get status(): ClaimStatus {
    return this.state.status;
  }
  get freshness(): ClaimFreshness {
    return this.state.freshness;
  }
  /** Sorted by evidence id. */
  get evidence(): readonly Evidence[] {
    return this.state.evidence;
  }
  get history(): readonly ClaimTransition[] {
    return this.state.history;
  }

  /** A new `unknown` or `inferred` claim (InferenceIntake, heuristics). `inferred` needs evidence. */
  static propose(p: ClaimProposal, hasher: Hasher): Result<KnowledgeClaim, DomainError> {
    const status = p.status as ClaimStatus;
    if (status !== 'unknown' && status !== 'inferred') return fail('PV_002_TRANSITION_INVALID', `a claim cannot be proposed as ${status}`);
    if (p.origin.kind === 'page') return fail('CLAIM_ORIGIN_INVALID', 'page claims are user assertions; use KnowledgeClaim.assertByUser');
    if (status === 'inferred' && p.evidence.length === 0) return fail('CLAIM_EVIDENCE_REQUIRED', 'an inferred claim cites at least one evidence item');
    return KnowledgeClaim.create(p, status, hasher);
  }

  /** A `user_asserted` claim from repo Markdown front matter (PV-005: its origin is the page). */
  static assertByUser(a: UserAssertion, hasher: Hasher): Result<KnowledgeClaim, DomainError> {
    if ((a.origin.kind as string) !== 'page') return fail('PV_005_ORIGIN_REQUIRED', 'a user assertion originates from a page');
    if (a.actor.kind !== 'user') return fail('PV_005_ORIGIN_REQUIRED', 'a user assertion is made by a user actor');
    return KnowledgeClaim.create(a, 'user_asserted', hasher);
  }

  private static create(p: Omit<ClaimProposal, 'status'>, status: ClaimStatus, hasher: Hasher): Result<KnowledgeClaim, DomainError> {
    const change = checkChange(p.actor, p.reason);
    if (!change.ok) return change;
    const origin = checkOrigin(p.origin);
    if (!origin.ok) return origin;
    const relation = checkRelation({ subject: p.subject, predicate: p.predicate, object: p.object, status });
    if (!relation.ok) return relation;
    const evidence = uniqueEvidence(p.evidence);
    if (!evidence.ok) return evidence;
    const subject = { id: p.subject.id, kind: p.subject.kind };
    const object = { id: p.object.id, kind: p.object.kind };
    return ok(
      new KnowledgeClaim({
        id: claimId(subject, p.predicate, object, p.origin, hasher),
        subject,
        predicate: p.predicate,
        object,
        origin: { kind: p.origin.kind, id: p.origin.id },
        status,
        freshness: 'current',
        evidence: evidence.value,
        history: Object.freeze([Object.freeze({ from: null, to: status, actor: formatActor(p.actor), reason: p.reason, seq: p.seq })]),
      }),
    );
  }

  private next(to: ClaimStatus, actor: ClaimActor, reason: string, seq: RevisionSeq, changes: Partial<ClaimState> = {}): Result<KnowledgeClaim, DomainError> {
    const state = { ...this.state, ...changes, status: to };
    const relation = checkRelation(state);
    if (!relation.ok) return relation;
    const entry = Object.freeze({ from: this.state.status, to, actor: formatActor(actor), reason, seq });
    return ok(new KnowledgeClaim({ ...state, history: Object.freeze([...this.state.history, entry]) }));
  }

  /** PV-002: any change except into `verified`, along the transition table. LLM actors are refused (AI-002). */
  transition(to: Exclude<ClaimStatus, 'verified'>, actor: ClaimActor, reason: string, seq: RevisionSeq): Result<KnowledgeClaim, DomainError> {
    const change = checkChange(actor, reason);
    if (!change.ok) return change;
    if (actor.kind === 'llm') return fail('AI_002_LLM_CANNOT_CHANGE_STATUS', 'LLM output never changes the status of an existing claim', { claim: this.id });
    if ((to as ClaimStatus) === 'verified') return fail('PV_002_VERIFY_REQUIRES_TOKEN', 'only ClaimVerifier can move a claim into verified', { claim: this.id });
    if (!TRANSITIONS[this.status].includes(to)) return fail('PV_002_TRANSITION_INVALID', `a ${this.status} claim cannot become ${to}`, { claim: this.id, from: this.status, to });
    if (this.status === 'user_asserted' && actor.kind !== 'user') return fail('PV_005_USER_CLAIM_PROTECTED', 'only the author edits a user assertion', { claim: this.id });
    if (to === 'inferred' && this.evidence.length === 0) return fail('CLAIM_EVIDENCE_REQUIRED', 'an inferred claim cites at least one evidence item', { claim: this.id });
    return this.next(to, actor, reason, seq);
  }

  /** Adds evidence; the status is unchanged (a later transition or verification may use it). */
  withEvidence(added: readonly Evidence[], actor: ClaimActor, reason: string, seq: RevisionSeq): Result<KnowledgeClaim, DomainError> {
    const change = checkChange(actor, reason);
    if (!change.ok) return change;
    if (this.status === 'user_asserted' && actor.kind !== 'user') return fail('PV_005_USER_CLAIM_PROTECTED', 'only the author edits a user assertion', { claim: this.id });
    const evidence = uniqueEvidence([...this.evidence, ...added]);
    if (!evidence.ok) return evidence;
    return this.next(this.status, actor, reason, seq, { evidence: evidence.value });
  }

  /** Into `verified`, only with a genuine token minted by ClaimVerifier for this claim and evidence set. */
  markVerified(token: VerificationToken, actor: ClaimActor, reason: string): Result<KnowledgeClaim, DomainError> {
    if (!VerificationToken.isGenuine(token)) return fail('PV_002_TOKEN_INVALID', 'the verification token was not issued by ClaimVerifier', { claim: this.id });
    if (token.claim !== this.id) return fail('PV_002_TOKEN_INVALID', `the token verifies ${token.claim}, not ${this.id}`, { claim: this.id });
    const current = evidenceIds(this.evidence);
    if (current.length !== token.evidence.length || current.some((id, i) => id !== token.evidence[i])) {
      return fail('PV_002_TOKEN_INVALID', 'the evidence changed since the token was issued', { claim: this.id });
    }
    if (!VERIFIABLE_FROM.includes(this.status)) return fail('PV_002_TRANSITION_INVALID', `a ${this.status} claim cannot become verified`, { claim: this.id, from: this.status });
    const change = checkChange(actor, reason);
    if (!change.ok) return change;
    return this.next('verified', actor, reason, token.seq, { freshness: 'current' });
  }
}
