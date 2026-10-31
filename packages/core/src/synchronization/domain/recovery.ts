/**
 * RecoveryService decision logic (SN-005). Pure: given unfinished revisions and the lease situation, it
 * decides what to do with each one. The application layer executes the plan.
 *
 * Phase 01 policy: an unfinished revision whose writer no longer holds a valid lease is ABANDONED. Resuming
 * from a checkpoint is allowed by SN-005 but deferred to Phase 05 (incremental jobs): a full index is cheaper
 * to restart than to checkpoint correctly. Either way, an unfinished revision is never published without
 * completing validation.
 */
import type { RevisionSeq } from '../../shared-kernel/index.js';
import type { RevisionStatus } from './types.js';

export interface UnfinishedRevision {
  readonly seq: RevisionSeq;
  readonly status: RevisionStatus;
}

export type RecoveryAction = { readonly kind: 'abandon'; readonly seq: RevisionSeq; readonly reason: string };

export interface RecoveryInput {
  readonly unfinished: readonly UnfinishedRevision[];
  /** True when another live writer currently holds a valid lease. Followers must not touch its staging. */
  readonly leaseHeldByOther: boolean;
}

export function planRecovery(input: RecoveryInput): readonly RecoveryAction[] {
  if (input.leaseHeldByOther) return [];
  return input.unfinished
    .filter((r) => r.status === 'building' || r.status === 'validating')
    .map((r) => ({ kind: 'abandon' as const, seq: r.seq, reason: `interrupted while ${r.status} (SN-005)` }));
}
