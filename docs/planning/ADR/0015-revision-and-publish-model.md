# ADR-0015: Revision Model: Validity-Interval Versioning with Atomic Pointer Publish

- **Status:** Accepted
- **Date:** 2026-10-31
- **Related:** SN-001..007, [KNOWLEDGE_GRAPH_DESIGN §6](../KNOWLEDGE_GRAPH_DESIGN.md), ADR-0008

## Context

These requirements together demand MVCC-like semantics:

- Partial updates are never published (SN-003).
- Published revisions are immutable (SN-007).
- Readers can pin a revision for the duration of a paginated query (API-002).
- Concurrent jobs never silently overwrite each other (SN-002).
- Incremental updates are cheap (O2).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Full copy of all rows per revision | Simple reads | Storage and time cost O(repo) per change; kills incremental indexing |
| Separate DB file per revision + file swap | Strong isolation | Copying the DB per change; Windows file locking during swap |
| **Validity intervals (`valid_from_seq`, `valid_to_seq`) + a current-revision pointer row** | Incremental writes touch only changed rows; pinned readers stay consistent; publish is one UPDATE | Every query must filter on intervals (enforced by views and repository ports); needs garbage collection |

## Decision

1. Each `index_revision` has a monotonically increasing `seq`, a `base_seq` and a `status`:

   ```
   building → validating → published → superseded
                 ↘ abandoned
   ```

2. Every revision-scoped row carries:
   - `valid_from_seq`: the revision that introduced it;
   - `valid_to_seq`: NULL, or the revision that removed or replaced it.

   A row is visible at revision `S` when `valid_from_seq ≤ S AND (valid_to_seq IS NULL OR valid_to_seq > S)`.
3. A build of revision `N` (where `base = current = N-1`):
   - inserts new rows with `valid_from_seq = N`;
   - sets `valid_to_seq = N` on removed rows.

   Readers at `N-1` are unaffected: their filter still sees the old rows, and none of the new ones.
4. **Publish** is one transaction:
   ```sql
   UPDATE workspace_head SET current_seq = :N, watermark = :W
    WHERE current_seq = :base     -- compare-and-swap (SN-002)
   ```
   It is preceded by `RevisionValidator` checks (KG-001, SY-002, SY-003 sampling, PV-001). If zero rows are updated, the result is `PublishConflict`.
5. **Abandon / crash recovery** (SN-005) cleans up a revision `N` that never published:
   - `DELETE … WHERE valid_from_seq = N`
   - `UPDATE … SET valid_to_seq = NULL WHERE valid_to_seq = N`
6. **Garbage collection.** Revisions older than `retention.keepRevisions` that are not pinned by an active cursor are compacted: rows with `valid_to_seq ≤ oldestKept` are deleted.
7. **Single writer.** A lease row (`index_lease`) with holder ID and expiry is held by one writer job per workspace (SN-004).

## Consequences

- **Stable identity keys.** Versioned rows reference append-only `node_key` and `file_key` tables, not row IDs. A node can then get a new version (for example a shifted range) without touching the edges that point at it, which keeps SN-007 and KG-001 compatible. Keys created by an abandoned revision are harmless orphans and are removed by GC.
- All reads go through repository methods that take `RevisionSeq`. Raw table access outside `adapters/sqlite` is forbidden (FF-BND-003).
- Index design: every hot table gets a composite index on `(key…, valid_to_seq)`. The details are specified in KNOWLEDGE_GRAPH_DESIGN §5.
