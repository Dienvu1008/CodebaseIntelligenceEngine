import type { Brand, DomainError, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';

/** Sequence number of a ChangeEvent in the workspace change log. 0 means "no events yet". */
export type ChangeSeq = Brand<number, 'ChangeSeq'>;

export function changeSeq(value: number): Result<ChangeSeq, DomainError> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return err(domainError('INVALID_CHANGE_SEQ', 'change seq must be a non-negative safe integer', { value }));
  }
  return ok(value as ChangeSeq);
}

/** IndexRevision lifecycle (ADR-0015). */
export type RevisionStatus = 'building' | 'validating' | 'published' | 'superseded' | 'abandoned';

/** IndexJob lifecycle (DOMAIN_MODEL §5). */
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type JobKind = 'full' | 'incremental' | 'reconcile';

export type ChangeKind = 'created' | 'changed' | 'deleted' | 'unknown';

/** Where a change hint came from. Hints are never trusted; they are confirmed by content hash (FR-051). */
export type ChangeOrigin = 'watcher' | 'client' | 'reconcile' | 'explicit';

/** Workspace freshness as reported to clients (SN-001, SN-006). */
export type Freshness = 'current' | 'stale' | 'unknown';
