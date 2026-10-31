/**
 * Structural node storage (FR-006): staging with the same diff semantics as files, revision-pinned reads,
 * and the WS-001 validation for nodes backed by a manifest file.
 */
import type Database from 'better-sqlite3';
import type { CanonicalPath, Ecosystem, NodeId, StageStats, StructuralKind, StructuralNode } from '@cie/core';

/** Same predicate shape as visibleAt in index-store.ts (FF-BND-003). Defined there and passed in to avoid a cycle. */
export type VisibleAt = (alias: string) => string;

interface NodeRow {
  id: number;
  node_id: string;
  kind: StructuralKind;
  name: string;
  ecosystem: Ecosystem | null;
  file_path: string | null;
}

const sameNode = (row: NodeRow, n: StructuralNode): boolean =>
  row.kind === n.kind && row.name === n.name && row.ecosystem === n.ecosystem && row.file_path === n.file;

/** Structural kinds share the node table with code nodes (graph-store.ts); every query here is limited to them. */
export const STRUCTURAL_KINDS_SQL = "('directory','package','project')";

export function selectNodes(db: Database.Database, visibleAt: VisibleAt, seq: number): NodeRow[] {
  const rows = db
    .prepare(`select n.id, k.node_id, k.kind, n.name, n.ecosystem, fk.path as file_path
              from node n join node_key k on k.key = n.node_key left join file_key fk on fk.key = n.file_key
              where ${visibleAt('n')} and n.kind in ${STRUCTURAL_KINDS_SQL}`)
    .all({ seq }) as NodeRow[];
  return rows.sort((a, b) => (a.node_id === b.node_id ? 0 : a.node_id < b.node_id ? -1 : 1));
}

export const toStructuralNode = (r: NodeRow): StructuralNode => ({
  id: r.node_id as NodeId,
  kind: r.kind,
  name: r.name,
  ecosystem: r.ecosystem,
  file: r.file_path as CanonicalPath | null,
});

export type StageNodesResult =
  | { readonly ok: true; readonly stats: StageStats }
  | { readonly ok: false; readonly nodeId: string; readonly file: string };

/**
 * Stages nodes. Every file reference is resolved BEFORE anything is written: a node whose backing file is
 * entirely unknown to the store fails staging (WS-001). A file that is known but not visible at this seq is
 * caught later by nodeViolations, so the two layers are independent.
 */
export function stageNodes(
  db: Database.Database,
  visibleAt: VisibleAt,
  seq: number,
  baseSeq: number | null,
  nodes: readonly StructuralNode[],
): StageNodesResult {
  const fileKeyOf = db.prepare('select key from file_key where path = ?').pluck();
  const fileKeys = new Map<string, number>();
  for (const n of nodes) {
    if (n.file === null) continue;
    const key = fileKeyOf.get(n.file) as number | undefined;
    if (key === undefined) return { ok: false, nodeId: n.id, file: n.file };
    fileKeys.set(n.file, key);
  }
  const byId = new Map((baseSeq === null ? [] : selectNodes(db, visibleAt, baseSeq)).map((r) => [r.node_id, r]));
  const stats = { inserted: 0, closed: 0, unchanged: 0 };
  const keyOf = db.prepare('select key from node_key where node_id = ?').pluck();
  const addKey = db.prepare('insert into node_key (node_id, kind) values (?, ?)');
  const close = db.prepare('update node set valid_to_seq = ? where id = ? and valid_to_seq is null');
  const insert = db.prepare('insert into node (node_key, kind, name, ecosystem, file_key, valid_from_seq) values (?, ?, ?, ?, ?, ?)');
  for (const n of nodes) {
    const old = byId.get(n.id);
    byId.delete(n.id);
    if (old !== undefined && sameNode(old, n)) {
      stats.unchanged++;
      continue;
    }
    if (old !== undefined) {
      close.run(seq, old.id);
      stats.closed++;
    }
    const key = (keyOf.get(n.id) as number | undefined) ?? Number(addKey.run(n.id, n.kind).lastInsertRowid);
    insert.run(key, n.kind, n.name, n.ecosystem, n.file === null ? null : (fileKeys.get(n.file) ?? null), seq);
    stats.inserted++;
  }
  for (const removed of byId.values()) {
    close.run(seq, removed.id);
    stats.closed++;
  }
  return { ok: true, stats };
}

/** WS-001 (a): every node backed by a file must have that file visible at the same seq. */
export function nodeViolations(db: Database.Database, visibleAt: VisibleAt, seq: number): string[] {
  const orphans = db
    .prepare(`select k.node_id, fk.path from node n join node_key k on k.key = n.node_key join file_key fk on fk.key = n.file_key
              where ${visibleAt('n')} and not exists (select 1 from file f where f.file_key = n.file_key and ${visibleAt('f')})`)
    .all({ seq }) as Array<{ node_id: string; path: string }>;
  const kindMismatch = db
    .prepare(`select k.node_id from node n join node_key k on k.key = n.node_key
              where ${visibleAt('n')} and n.kind in ${STRUCTURAL_KINDS_SQL} and ((k.kind = 'directory') <> (n.file_key is null))`)
    .pluck()
    .all({ seq }) as string[];
  return [
    ...orphans.map((o) => `WS-001: node ${o.node_id} references ${o.path}, which is not visible at seq ${seq}`),
    ...kindMismatch.map((id) => `KG-003: node ${id} has an inconsistent backing record for its kind`),
  ];
}
