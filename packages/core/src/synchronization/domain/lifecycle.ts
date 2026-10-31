/**
 * IndexRevision and IndexJob state machines (DOMAIN_MODEL §5, ADR-0015). Pure transition functions:
 * persistence adapters call these before writing, so an illegal transition never reaches the store.
 */
import type { DomainError, Result } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import type { JobState, RevisionStatus } from './types.js';

const REVISION_TRANSITIONS: Readonly<Record<RevisionStatus, readonly RevisionStatus[]>> = {
  building: ['validating', 'abandoned'],
  validating: ['published', 'abandoned'],
  published: ['superseded'],
  superseded: [],
  abandoned: [],
};

const JOB_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'failed', 'cancelled'],
  succeeded: [],
  failed: [],
  cancelled: [],
};

export function revisionTransition(from: RevisionStatus, to: RevisionStatus): Result<RevisionStatus, DomainError> {
  return REVISION_TRANSITIONS[from].includes(to)
    ? ok(to)
    : err(domainError('ILLEGAL_REVISION_TRANSITION', `revision cannot move from ${from} to ${to}`, { from, to }));
}

export function jobTransition(from: JobState, to: JobState): Result<JobState, DomainError> {
  return JOB_TRANSITIONS[from].includes(to)
    ? ok(to)
    : err(domainError('ILLEGAL_JOB_TRANSITION', `job cannot move from ${from} to ${to}`, { from, to }));
}

/** Published revisions are immutable (SN-007); only these statuses still accept staged writes. */
export const isStaging = (status: RevisionStatus): boolean => status === 'building';
