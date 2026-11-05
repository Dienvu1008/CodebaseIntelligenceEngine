/**
 * GraphReadModel over the SQLite store (KNOWLEDGE_GRAPH_DESIGN §8). Bounded recursive traversals and
 * single-hop neighbor queries, all pinned to a published seq and filtered through `visibleAt`.
 *
 * The recursive CTE walks `edge` by `from_key`/`to_key` (the `edge_out`/`edge_in` indexes), uses `UNION`
 * (not `UNION ALL`) on `(node_key, depth)` for cycle safety, and selects `limit + 1` rows so the caller can
 * tell a full result from a truncated one. Depth and limit are already clamped to the server caps by the
 * core `clampBounds`, so a traversal can never load the whole graph (KG-004, R-06).
 */
import type Database from 'better-sqlite3';
import {
  ok,
  type DomainError,
  type NeighborRequest,
  type NeighborResult,
  type NodeId,
  type ReachedNode,
  type Result,
  type RevisionSeq,
  type TraversalRequest,
  type TraversalResult,
} from '@cie/core';
import type { CodeEdge, CodeEdgeType } from '@cie/core';
import type { VisibleAt } from './structure-store.js';

type Status = ReachedNode['status'];

/** The SQL fragment listing edge types, or empty when every type is allowed. */
function typeFilter(types: readonly CodeEdgeType[]): { sql: string; params: Record<string, string> } {
  if (types.length === 0) return { sql: '', params: {} };
  const params: Record<string, string> = {};
  const names = types.map((t, i) => {
    params[`t${i}`] = t;
    return `@t${i}`;
  });
  return { sql: `and e.type in (${names.join(', ')})`, params };
}

export function traverse(db: Database.Database, visibleAt: VisibleAt, seq: RevisionSeq, request: TraversalRequest): Result<TraversalResult, DomainError> {
  const start = nodeKeyOf(db, request.start);
  if (start === null) return ok({ nodes: [], truncated: false });
  const near = request.direction === 'out' ? 'from_key' : 'to_key';
  const far = request.direction === 'out' ? 'to_key' : 'from_key';
  const filter = typeFilter(request.types);
  // weakest status so far is carried as an integer rank (0 verified .. 2 unknown) and decoded after.
  const sql = `
    with recursive reach(node_key, depth, rank) as (
      select @start, 0, 0
      union
      select e.${far}, r.depth + 1,
             max(r.rank, case e.status when 'verified' then 0 when 'unknown' then 2 else 1 end)
      from reach r
      join edge e on e.${near} = r.node_key and ${visibleAt('e')} ${filter.sql}
      where r.depth < @maxDepth
    )
    select k.node_id, r.depth, r.rank from reach r
    join node_key k on k.key = r.node_key
    where r.depth > 0
    order by r.depth, k.node_id
    limit @limit`;
  const rows = db
    .prepare(sql)
    .all({ start, seq, maxDepth: request.maxDepth, limit: request.limit + 1, ...filter.params }) as Array<{ node_id: string; depth: number; rank: number }>;
  const truncated = rows.length > request.limit;
  const nodes: ReachedNode[] = rows.slice(0, request.limit).map((r) => ({ id: r.node_id as NodeId, depth: r.depth, status: rankToStatus(r.rank) }));
  return ok({ nodes, truncated });
}

const RANKS: readonly Status[] = ['verified', 'inferred', 'unknown'];
const rankToStatus = (rank: number): Status => RANKS[rank] ?? 'unknown';

export function neighbors(db: Database.Database, visibleAt: VisibleAt, seq: RevisionSeq, request: NeighborRequest): Result<NeighborResult, DomainError> {
  const start = nodeKeyOf(db, request.start);
  if (start === null) return ok({ groups: [] });
  const near = request.direction === 'out' ? 'from_key' : 'to_key';
  const far = request.direction === 'out' ? 'to_key' : 'from_key';
  const filter = typeFilter(request.types);
  // One extra row per type detects truncation. Order by type then node id for a deterministic result.
  const rows = db
    .prepare(
      `select e.type, k.node_id, e.status, e.precision,
              row_number() over (partition by e.type order by k.node_id) as rn
       from edge e join node_key k on k.key = e.${far}
       where e.${near} = @start and ${visibleAt('e')} ${filter.sql}`,
    )
    .all({ start, seq, ...filter.params }) as Array<{ type: CodeEdgeType; node_id: string; status: Status; precision: CodeEdge['precision']; rn: number }>;
  const byType = new Map<CodeEdgeType, { edges: NeighborResult['groups'][number]['edges'][number][]; truncated: boolean }>();
  for (const r of rows) {
    const group = byType.get(r.type) ?? { edges: [], truncated: false };
    if (r.rn <= request.limit) group.edges.push({ type: r.type, node: r.node_id as NodeId, status: r.status, precision: r.precision });
    else group.truncated = true;
    byType.set(r.type, group);
  }
  const groups = [...byType.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([type, g]) => ({ type, edges: g.edges, truncated: g.truncated }));
  return ok({ groups });
}

export function nodeExists(db: Database.Database, visibleAt: VisibleAt, seq: RevisionSeq, start: NodeId): Result<boolean, DomainError> {
  const key = nodeKeyOf(db, start);
  if (key === null) return ok(false);
  const row = db.prepare(`select 1 from node n where n.node_key = @key and ${visibleAt('n')} limit 1`).get({ key, seq });
  return ok(row !== undefined);
}

/** The stable key of a node id, independent of any revision (node_key is append-only), or null if unknown. */
function nodeKeyOf(db: Database.Database, id: NodeId): number | null {
  const row = db.prepare('select key from node_key where node_id = ?').pluck().get(id) as number | undefined;
  return row ?? null;
}


