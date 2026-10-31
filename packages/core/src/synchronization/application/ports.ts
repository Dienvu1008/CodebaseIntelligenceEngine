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
import type { ManifestEntry, StructuralNode } from '../../workspace/public.js';
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

export interface StageStats {
  readonly inserted: number;
  readonly closed: number;
  readonly unchanged: number;
}

/**
 * Unit of work for staging and publishing a revision (SN-002, SN-003, SN-007).
 * Refined in Phase 01: staging, validation and the PUBLISH_CONFLICT error code (a DomainError).
 */
export interface RevisionWriter {
  /** Starts revision head+1 (status building) on top of `base`. Seqs are never reused, including abandoned ones. */
  begin(base: RevisionSeq | null, jobId: JobId): Promise<Result<RevisionRecord, DomainError>>;
  /**
   * Stages the complete file manifest of the revision. Rows identical to the base stay untouched, changed
   * rows get a new version (valid_from = seq), and removed or changed rows are closed (valid_to = seq).
   */
  stageManifest(seq: RevisionSeq, entries: readonly ManifestEntry[]): Promise<Result<StageStats, DomainError>>;
  /** Stages the structural nodes with the same diff semantics, keyed by node id. Requires the manifest staged first. */
  stageStructure(seq: RevisionSeq, nodes: readonly StructuralNode[]): Promise<Result<StageStats, DomainError>>;
  markValidating(seq: RevisionSeq): Promise<Result<void, DomainError>>;
  /** RevisionValidator checks on the staged revision. An empty list means valid. */
  validate(seq: RevisionSeq): Promise<readonly string[]>;
  /**
   * Compare-and-swap of the head pointer from the revision's base to `seq`, in a single transaction. If the
   * head moved, it fails with code PUBLISH_CONFLICT and changes nothing (SN-002).
   */
  publish(seq: RevisionSeq, watermark: ChangeSeq): Promise<Result<void, DomainError>>;
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
  /** True when a holder other than `holder` owns a live lease (used by recovery: followers never recover). */
  heldByOther(holder: string): Promise<boolean>;
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
