/**
 * PublishPolicy (SN-001, SN-002, SN-003) and FreshnessEvaluator (SN-001). Pure domain services.
 *
 * The compare-and-swap is also enforced atomically by the store (SN-002). This policy is the domain-level
 * precondition check, and it gives typed reasons instead of a bare "0 rows updated".
 */
import type { DomainError, Result, RevisionSeq } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import type { ChangeSeq, Freshness, RevisionStatus } from './types.js';

export interface PublishCandidate {
  readonly seq: RevisionSeq;
  readonly baseSeq: RevisionSeq | null;
  readonly status: RevisionStatus;
  /** Highest change-event seq this revision fully incorporates. */
  readonly watermark: ChangeSeq;
}

export interface PublishContext {
  readonly candidate: PublishCandidate;
  /** Current head seq, or null if nothing was published yet. */
  readonly headSeq: RevisionSeq | null;
  /** Highest seq of the change set the revision was built from. */
  readonly sourceMaxChangeSeq: ChangeSeq;
  /** Violations reported by the RevisionValidator. Must be empty. */
  readonly violations: readonly string[];
}

export function decidePublish(ctx: PublishContext): Result<void, DomainError> {
  const { candidate } = ctx;
  if (candidate.status !== 'validating') {
    return err(domainError('PUBLISH_NOT_VALIDATED', 'only a revision in status validating can be published', { status: candidate.status }));
  }
  if (ctx.violations.length > 0) {
    return err(domainError('PUBLISH_VALIDATION_FAILED', 'the revision failed validation (SN-003)', { violations: [...ctx.violations] }));
  }
  if (candidate.baseSeq !== ctx.headSeq) {
    return err(domainError('PUBLISH_CONFLICT', 'the head moved since this revision was started (SN-002)', {
      expectedBase: candidate.baseSeq,
      actualHead: ctx.headSeq,
    }));
  }
  if (candidate.watermark < ctx.sourceMaxChangeSeq) {
    return err(domainError('PUBLISH_WATERMARK_BEHIND', 'the revision has not processed every change it was built from (SN-001)', {
      watermark: candidate.watermark,
      sourceMaxChangeSeq: ctx.sourceMaxChangeSeq,
    }));
  }
  return ok(undefined);
}

export interface FreshnessInput {
  /** Watermark of the published head, or null if nothing was published. */
  readonly headWatermark: ChangeSeq | null;
  /** Highest seq of change events that affect included paths, or null if none were recorded. */
  readonly latestRelevantChangeSeq: ChangeSeq | null;
  /** 'degraded' when the watcher overflowed or failed and no reconciliation has happened since. */
  readonly changeTracking: 'reliable' | 'degraded';
}

/** SN-001: current iff a published head exists and no relevant change lies beyond its watermark. */
export function evaluateFreshness(input: FreshnessInput): Freshness {
  if (input.headWatermark === null || input.changeTracking === 'degraded') return 'unknown';
  if (input.latestRelevantChangeSeq !== null && input.latestRelevantChangeSeq > input.headWatermark) return 'stale';
  return 'current';
}
