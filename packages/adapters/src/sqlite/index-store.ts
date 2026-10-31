/**
 * SQLite IndexStore (ADR-0015): revision metadata, staging, validation, compare-and-swap publish and
 * abandon, plus the revision-pinned file read model.
 *
 * Every write runs in one transaction that first checks the writer still owns the lease (SN-004), so a
 * writer whose lease expired cannot keep writing. Reads are pinned to a published seq and filter rows
 * through `visibleAt` (SN-003). Visible rows are never updated in place, except setting valid_to_seq to
 * a later seq (SN-007).
 */
import type Database from 'better-sqlite3';
import {
  canonicalizePath,
  changeSeq,
  decidePublish,
  domainError,
  err,
  ok,
  parseContentHash,
  revisionSeq,
  revisionTransition,
  type ChangeSeq,
  type Clock,
  type DomainError,
  type FileManifestReader,
  type HeadState,
  type JobId,
  type ManifestEntry,
  type Result,
  type RevisionRecord,
  type RevisionSeq,
  type RevisionStatus,
  type RevisionStore,
  type RevisionWriter,
  type SkipReason,
  type StageStats,
} from '@cie/core';
import { SqliteLeaseManager } from './lease.js';

/** The single source of the visibility predicate (FF-BND-003). Binds the named parameter @seq. */
export const visibleAt = (alias: string): string =>
  `${alias}.valid_from_seq <= @seq and (${alias}.valid_to_seq is null or ${alias}.valid_to_seq > @seq)`;

interface RevisionRow {
  seq: number;
  base_seq: number | null;
  status: RevisionStatus;
  watermark: number;
  job_id: string;
  staged: number;
}

interface FileRow {
  id: number;
  file_key: number;
  path: string;
  status: 'indexed' | 'skipped';
  hash: string | null;
  skip_reason: string | null;
  size: number;
  lang: string | null;
}

const must = <T>(r: Result<T, DomainError>): T => {
  if (!r.ok) throw new Error(`invariant broken in stored data: ${r.error.code}`);
  return r.value;
};

function toRecord(row: RevisionRow): RevisionRecord {
  return {
    seq: must(revisionSeq(row.seq)),
    baseSeq: row.base_seq === null ? null : must(revisionSeq(row.base_seq)),
    status: row.status,
    watermark: must(changeSeq(row.watermark)),
    jobId: row.job_id as JobId,
  };
}

function toEntry(row: FileRow): ManifestEntry {
  const path = must(canonicalizePath(row.path));
  return row.status === 'indexed'
    ? { path, status: 'indexed', hash: must(parseContentHash(row.hash ?? '')), size: row.size, language: row.lang }
    : { path, status: 'skipped', reason: row.skip_reason as SkipReason, size: row.size };
}

const sameVersion = (row: FileRow, e: ManifestEntry): boolean =>
  e.status === 'indexed'
    ? row.status === 'indexed' && row.hash === e.hash && row.size === e.size && row.lang === e.language
    : row.status === 'skipped' && row.skip_reason === e.reason && row.size === e.size;

export class SqliteIndexStore implements RevisionStore, RevisionWriter, FileManifestReader {
  readonly lease: SqliteLeaseManager;

  constructor(
    private readonly db: Database.Database,
    private readonly clock: Clock,
    /** Lease holder id of this process. Writes are refused unless it owns a live lease. */
    private readonly holder: string,
  ) {
    this.lease = new SqliteLeaseManager(db, clock);
  }

  // ---------------------------------------------------------------- read side

  async head(): Promise<HeadState | null> {
    const row = this.db.prepare('select current_seq, watermark from workspace_head where id = 1').get() as { current_seq: number | null; watermark: number };
    return row.current_seq === null ? null : { seq: must(revisionSeq(row.current_seq)), watermark: must(changeSeq(row.watermark)) };
  }

  async get(seq: RevisionSeq): Promise<RevisionRecord | null> {
    const row = this.db.prepare('select * from index_revision where seq = ?').get(seq) as RevisionRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  async listUnfinished(): Promise<readonly RevisionRecord[]> {
    const rows = this.db.prepare("select * from index_revision where status in ('building','validating') order by seq").all() as RevisionRow[];
    return rows.map(toRecord);
  }

  /** Files visible at a published revision (SN-003: staging and abandoned seqs are never readable). */
  async filesAt(seq: RevisionSeq): Promise<Result<readonly ManifestEntry[], DomainError>> {
    const rev = this.db.prepare('select status from index_revision where seq = ?').get(seq) as { status: RevisionStatus } | undefined;
    if (rev === undefined || (rev.status !== 'published' && rev.status !== 'superseded')) {
      return err(domainError('REVISION_NOT_VISIBLE', 'only published revisions can be read', { seq }));
    }
    return ok(this.selectFiles(seq).map(toEntry));
  }

  private selectFiles(seq: number): FileRow[] {
    // Ordering uses the UTF-16 code-unit order of canonical paths. SQLite's default BINARY collation
    // compares UTF-8 bytes, which orders astral characters differently, so the final sort is in JS (WS-004).
    const rows = this.db
      .prepare(`select f.id, f.file_key, k.path, f.status, f.hash, f.skip_reason, f.size, f.lang
                from file f join file_key k on k.key = f.file_key where ${visibleAt('f')}`)
      .all({ seq }) as FileRow[];
    return rows.sort((a, b) => (a.path === b.path ? 0 : a.path < b.path ? -1 : 1));
  }

  // ---------------------------------------------------------------- write side

  /** Runs `fn` in one transaction, after verifying that this process owns a live lease (SN-004). */
  private write<T>(fn: () => Result<T, DomainError>): Result<T, DomainError> {
    return this.db.transaction(() => {
      if (!this.lease.holds(this.holder)) return err(domainError('LEASE_NOT_HELD', 'writes require a live index lease (SN-004)'));
      return fn();
    }).immediate();
  }

  private revisionRow(seq: number): RevisionRow | undefined {
    return this.db.prepare('select * from index_revision where seq = ?').get(seq) as RevisionRow | undefined;
  }

  private setStatus(row: RevisionRow, to: RevisionStatus): Result<void, DomainError> {
    const t = revisionTransition(row.status, to);
    if (!t.ok) return t;
    this.db.prepare('update index_revision set status = ? where seq = ?').run(to, row.seq);
    return ok(undefined);
  }

  async begin(base: RevisionSeq | null, jobId: JobId): Promise<Result<RevisionRecord, DomainError>> {
    return this.write(() => {
      const head = (this.db.prepare('select current_seq from workspace_head where id = 1').get() as { current_seq: number | null }).current_seq;
      if (head !== base) return err(domainError('PUBLISH_CONFLICT', 'base is not the current head', { expectedBase: base, actualHead: head }));
      const open = this.db.prepare("select seq from index_revision where status in ('building','validating')").get() as { seq: number } | undefined;
      if (open !== undefined) return err(domainError('STAGING_IN_PROGRESS', 'another revision is still being built', { seq: open.seq }));
      const next = ((this.db.prepare('select max(seq) as m from index_revision').get() as { m: number | null }).m ?? 0) + 1;
      this.db
        .prepare("insert into index_revision (seq, base_seq, status, watermark, job_id, created_at_ms) values (?, ?, 'building', 0, ?, ?)")
        .run(next, base, jobId, this.clock.nowMs());
      return ok(toRecord(this.revisionRow(next) as RevisionRow));
    });
  }

  async stageManifest(seq: RevisionSeq, entries: readonly ManifestEntry[]): Promise<Result<StageStats, DomainError>> {
    return this.write(() => {
      const rev = this.revisionRow(seq);
      if (rev === undefined || rev.status !== 'building') return err(domainError('NOT_STAGING', 'revision is not in status building', { seq }));
      if (rev.staged === 1) return err(domainError('ALREADY_STAGED', 'the manifest of this revision was already staged', { seq }));
      const baseRows = rev.base_seq === null ? [] : this.selectFiles(rev.base_seq);
      const byPath = new Map(baseRows.map((r) => [r.path, r]));
      const stats = { inserted: 0, closed: 0, unchanged: 0 };
      const keyOf = this.db.prepare('select key from file_key where path = ?').pluck();
      const addKey = this.db.prepare('insert into file_key (path) values (?)');
      const close = this.db.prepare('update file set valid_to_seq = ? where id = ? and valid_to_seq is null');
      const insert = this.db.prepare(
        'insert into file (file_key, status, hash, skip_reason, size, lang, valid_from_seq) values (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const e of entries) {
        const old = byPath.get(e.path);
        byPath.delete(e.path);
        if (old !== undefined && sameVersion(old, e)) {
          stats.unchanged++;
          continue;
        }
        if (old !== undefined) {
          close.run(seq, old.id);
          stats.closed++;
        }
        const key = (keyOf.get(e.path) as number | undefined) ?? Number(addKey.run(e.path).lastInsertRowid);
        if (e.status === 'indexed') insert.run(key, 'indexed', e.hash, null, e.size, e.language, seq);
        else insert.run(key, 'skipped', null, e.reason, e.size, null, seq);
        stats.inserted++;
      }
      for (const removed of byPath.values()) {
        close.run(seq, removed.id);
        stats.closed++;
      }
      this.db.prepare('update index_revision set staged = 1 where seq = ?').run(seq);
      return ok(stats);
    });
  }

  async markValidating(seq: RevisionSeq): Promise<Result<void, DomainError>> {
    return this.write(() => {
      const rev = this.revisionRow(seq);
      return rev === undefined ? err(domainError('REVISION_NOT_FOUND', 'unknown revision', { seq })) : this.setStatus(rev, 'validating');
    });
  }

  /** RevisionValidator checks (Phase 01 subset: WS-001 a for file records, head uniqueness, FK integrity). */
  async validate(seq: RevisionSeq): Promise<readonly string[]> {
    return this.validateSync(seq);
  }

  /** Synchronous so that publish can re-validate inside its own transaction (no gap between check and swap). */
  private validateSync(seq: number): string[] {
    const violations: string[] = [];
    const rev = this.revisionRow(seq);
    if (rev === undefined) return [`revision ${seq} does not exist`];
    if (rev.staged !== 1) violations.push(`revision ${seq} has no staged manifest`);
    const dup = this.db
      .prepare(`select k.path from file f join file_key k on k.key = f.file_key where ${visibleAt('f')} group by f.file_key having count(*) > 1`)
      .pluck()
      .all({ seq }) as string[];
    for (const p of dup) violations.push(`WS-001/SY-002: path visible twice at seq ${seq}: ${p}`);
    const badPaths = this.db
      .prepare(`select k.path from file f join file_key k on k.key = f.file_key where ${visibleAt('f')}`)
      .pluck()
      .all({ seq }) as string[];
    for (const p of badPaths) {
      const c = canonicalizePath(p);
      if (!c.ok || c.value !== p) violations.push(`WS-002: stored path is not canonical: ${p}`);
    }
    const fk = this.db.pragma('foreign_key_check') as unknown[];
    if (fk.length > 0) violations.push(`FF-DAT-001: ${fk.length} foreign-key violation(s)`);
    return violations;
  }

  /**
   * Store-level guarantees: status validating, no validation violations, atomic CAS on the head
   * (SN-002, SN-003). The SN-001 watermark rule (watermark >= the source change set) needs the change
   * set, which only the caller knows, so IndexService checks it with decidePublish before calling this.
   */
  async publish(seq: RevisionSeq, watermark: ChangeSeq): Promise<Result<void, DomainError>> {
    return this.write(() => {
      const rev = this.revisionRow(seq);
      if (rev === undefined) return err(domainError('REVISION_NOT_FOUND', 'unknown revision', { seq }));
      const head = (this.db.prepare('select current_seq from workspace_head where id = 1').get() as { current_seq: number | null }).current_seq;
      const decision = decidePublish({
        candidate: { ...toRecord(rev), watermark },
        headSeq: head === null ? null : must(revisionSeq(head)),
        sourceMaxChangeSeq: watermark, // see the doc comment: SN-001 is the caller's check
        violations: this.validateSync(seq),
      });
      if (!decision.ok) return decision;
      // Compare-and-swap: succeeds only if the head is still the revision's base (SN-002).
      const swapped = this.db
        .prepare('update workspace_head set current_seq = ?, watermark = ? where id = 1 and current_seq is ?')
        .run(seq, watermark, rev.base_seq).changes;
      if (swapped !== 1) return err(domainError('PUBLISH_CONFLICT', 'the head moved during publish', { expectedBase: rev.base_seq }));
      this.db.prepare('update index_revision set watermark = ?, published_at_ms = ? where seq = ?').run(watermark, this.clock.nowMs(), seq);
      const published = this.setStatus(rev, 'published');
      if (!published.ok) return published;
      if (rev.base_seq !== null) {
        const prev = this.revisionRow(rev.base_seq);
        if (prev !== undefined && prev.status === 'published') this.setStatus(prev, 'superseded');
      }
      return ok(undefined);
    });
  }

  async abandon(seq: RevisionSeq, reason: string): Promise<Result<void, DomainError>> {
    return this.write(() => {
      const rev = this.revisionRow(seq);
      if (rev === undefined) return err(domainError('REVISION_NOT_FOUND', 'unknown revision', { seq }));
      const status = this.setStatus(rev, 'abandoned');
      if (!status.ok) return status;
      // ADR-0015 §5: remove what the revision introduced, re-open what it closed.
      this.db.prepare('delete from file where valid_from_seq = ?').run(seq);
      this.db.prepare('update file set valid_to_seq = null where valid_to_seq = ?').run(seq);
      this.db.prepare('update index_revision set abandon_reason = ? where seq = ?').run(reason, seq);
      return ok(undefined);
    });
  }
}
