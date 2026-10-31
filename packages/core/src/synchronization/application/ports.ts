/**
 * Synchronization ports needed by Phase 01 (SYSTEM_ARCHITECTURE §7, ADR-0015). Phase 00 declares types
 * only. Methods for staging record types (files, nodes, edges) are added by the phase that introduces
 * each record type.
 */
import type {
  CanonicalPath,
  DomainError,
  JobId,
  Result,
  RevisionSeq,
} from '../../shared-kernel/index.js';
import type {
  ChangeKind,
  ChangeOrigin,
  ChangeSeq,
  JobKind,
  JobState,
  RevisionStatus,
} from '../domain/types.js';

export interface HeadState {
  readonly seq: RevisionSeq;
  readonly watermark: ChangeSeq;
}

export interface RevisionRecord {
  readonly seq: RevisionSeq;
  readonly baseSeq: RevisionSeq | null;
  readonly status: RevisionStatus;
  readonly watermark: ChangeSeq;
  readonly jobId: JobId;
}

/** Read side of revision metadata. */
export interface RevisionStore {
  head(): Promise<HeadState | null>;
  get(seq: RevisionSeq): Promise<RevisionRecord | null>;
  /** Revisions in `building` or `validating`, used by recovery (SN-005). */
  listUnfinished(): Promise<readonly RevisionRecord[]>;
}

export interface PublishConflict {
  readonly code: 'PUBLISH_CONFLICT';
  readonly expectedBase: RevisionSeq | null;
  readonly actualHead: RevisionSeq | null;
}

/** Unit of work for staging and publishing a revision (SN-002, SN-003, SN-007). */
export interface RevisionWriter {
  begin(base: RevisionSeq | null, jobId: JobId): Promise<Result<RevisionRecord, DomainError>>;
  markValidating(seq: RevisionSeq): Promise<Result<void, DomainError>>;
  /** Compare-and-swap on the head pointer, in a single transaction. */
  publish(seq: RevisionSeq, watermark: ChangeSeq): Promise<Result<void, PublishConflict | DomainError>>;
  /** Rolls back every row the revision introduced or closed (ADR-0015 §5). */
  abandon(seq: RevisionSeq, reason: string): Promise<Result<void, DomainError>>;
}

export interface Lease {
  readonly holder: string;
  readonly expiresAtMs: number;
}

/** Single-writer lease per workspace (SN-004). */
export interface LeaseManager {
  acquire(holder: string, ttlMs: number): Promise<Result<Lease, DomainError>>;
  renew(lease: Lease, ttlMs: number): Promise<Result<Lease, DomainError>>;
  release(lease: Lease): Promise<void>;
}

export interface JobRecord {
  readonly id: JobId;
  readonly kind: JobKind;
  readonly state: JobState;
  readonly targetSeq: RevisionSeq | null;
}

export interface JobRepository {
  save(job: JobRecord): Promise<void>;
  get(id: JobId): Promise<JobRecord | null>;
  listActive(): Promise<readonly JobRecord[]>;
}

export interface ChangeHint {
  readonly path: CanonicalPath;
  readonly kind: ChangeKind;
  readonly origin: ChangeOrigin;
}

export interface ChangeEvent extends ChangeHint {
  readonly seq: ChangeSeq;
}

export type Unsubscribe = () => void;

/** Source of change hints: watcher, client notifications, reconciliation scans. */
export interface ChangeSource {
  subscribe(listener: (hints: readonly ChangeHint[]) => void): Unsubscribe;
}
