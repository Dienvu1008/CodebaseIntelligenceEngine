import type { Brand } from '../../shared-kernel/index.js';

/** Sequence number of a ChangeEvent in the workspace change log. */
export type ChangeSeq = Brand<number, 'ChangeSeq'>;

/** IndexRevision lifecycle (ADR-0015). */
export type RevisionStatus = 'building' | 'validating' | 'published' | 'superseded' | 'abandoned';

/** IndexJob lifecycle (DOMAIN_MODEL §5). */
export type JobState = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';

export type JobKind = 'full' | 'incremental' | 'reconcile';

export type ChangeKind = 'created' | 'changed' | 'deleted' | 'unknown';

/** Where a change hint came from. Hints are never trusted; they are confirmed by content hash (FR-051). */
export type ChangeOrigin = 'watcher' | 'client' | 'reconcile' | 'explicit';
