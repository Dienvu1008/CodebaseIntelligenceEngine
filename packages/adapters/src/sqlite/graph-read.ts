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
  exploreBudget,
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

const nearColumn = (d: 'out' | 'in'): string => (d === 'out' ? 'from_key' : 'to_key');
const farColumn = (d: 'out' | 'in'): string => (d === 'out' ? 'to_key' : 'from_key');

/**
 * The statements of the read model, exported so the FF-PRF-004 plan test examines exactly what runs.
 * Every statement joins `edge` on its endpoint key (edge_out / edge_in) or `node` / `node_key` on their keys.
 */
export const GRAPH_STATEMENTS = {
  /** The `and e.type in (…)` fragment and its parameters for a list of edge types (empty: no filter). */
  typeFilter,
  /** Stable key of a node id (the unique index on node_key.node_id). */
  nodeKey: 'select key from node_key where node_id = ?',
  /** Is the node visible at @seq? (node_key_vis: node_key, valid_to_seq). */
  nodeExists: (visibleAt: VisibleAt): string => `select 1 from node n where n.node_key = @key and ${visibleAt('n')} limit 1`,
  /**
   * Bounded recursive traversal (FF-PRF-004: bounded work, not only bounded output).
   *  - The CTE carries (node, depth, rank), where rank is the weakest status on the path so far
   *    (0 verified, 1 inferred, 2 unknown). SQLite's recursive queue is FIFO, so it explores breadth first,
   *    and `limit @budget` inside the CTE stops it after that many states, however dense the graph is.
   *  - The outer query lists each node once, at its shallowest depth, with the strongest rank among the
   *    shortest paths. `explored` (the number of states the CTE produced) tells the caller whether the budget
   *    was exhausted, in which case the result is reported truncated.
   */
  traverse: (visibleAt: VisibleAt, direction: 'out' | 'in', typeSql: string): string => `
    with recursive reach(node_key, depth, rank) as (
      select @start, 0, 0
      union
      select e.${farColumn(direction)}, r.depth + 1,
             max(r.rank, case e.status when 'verified' then 0 when 'unknown' then 2 else 1 end)
      from reach r
      join edge e on e.${nearColumn(direction)} = r.node_key and ${visibleAt('e')} ${typeSql}
      where r.depth < @maxDepth
      limit @budget
    )
    select node_id, depth, rank, (select count(*) from reach) as explored from (
      select k.node_id as node_id, r.depth as depth, r.rank as rank,
             row_number() over (partition by r.node_key order by r.depth, r.rank) as rn
      from reach r join node_key k on k.key = r.node_key
      where r.depth > 0
    )
    where rn = 1
    order by depth, node_id
    limit @limit`,
  /** One hop with a per-type row number, so each type group can be capped and its truncation detected. */
  neighbors: (visibleAt: VisibleAt, direction: 'out' | 'in', typeSql: string): string =>
    `select e.type, k.node_id, e.status, e.precision,
            row_number() over (partition by e.type order by k.node_id) as rn
     from edge e join node_key k on k.key = e.${farColumn(direction)}
     where e.${nearColumn(direction)} = @start and ${visibleAt('e')} ${typeSql}`,
} as const;

export function traverse(db: Database.Database, visibleAt: VisibleAt, seq: RevisionSeq, request: TraversalRequest): Result<TraversalResult, DomainError> {
  const start = nodeKeyOf(db, request.start);
  if (start === null) return ok({ nodes: [], truncated: false });
  const filter = typeFilter(request.types);
  const budget = exploreBudget(request.limit);
  const rows = db
    .prepare(GRAPH_STATEMENTS.traverse(visibleAt, request.direction, filter.sql))
    .all({ start, seq, maxDepth: request.maxDepth, limit: request.limit + 1, budget, ...filter.params }) as Array<{ node_id: string; depth: number; rank: number; explored: number }>;
  // Truncated: more nodes than the limit, or the exploration budget ran out (then the list may be short).
  const truncated = rows.length > request.limit || (rows[0]?.explored ?? 0) >= budget;
  const nodes: ReachedNode[] = rows.slice(0, request.limit).map((r) => ({ id: r.node_id as NodeId, depth: r.depth, status: rankToStatus(r.rank) }));
  return ok({ nodes, truncated });
}

const RANKS: readonly Status[] = ['verified', 'inferred', 'unknown'];
const rankToStatus = (rank: number): Status => RANKS[rank] ?? 'unknown';

export function neighbors(db: Database.Database, visibleAt: VisibleAt, seq: RevisionSeq, request: NeighborRequest): Result<NeighborResult, DomainError> {
  const start = nodeKeyOf(db, request.start);
  if (start === null) return ok({ groups: [] });
  const filter = typeFilter(request.types);
  const rows = db
    .prepare(GRAPH_STATEMENTS.neighbors(visibleAt, request.direction, filter.sql))
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
  const row = db.prepare(GRAPH_STATEMENTS.nodeExists(visibleAt)).get({ key, seq });
  return ok(row !== undefined);
}

/** The stable key of a node id, independent of any revision (node_key is append-only), or null if unknown. */
function nodeKeyOf(db: Database.Database, id: NodeId): number | null {
  const row = db.prepare(GRAPH_STATEMENTS.nodeKey).pluck().get(id) as number | undefined;
  return row ?? null;
}
