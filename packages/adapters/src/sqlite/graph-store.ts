/**
 * Code graph storage (Phase 02, P02-08): module/symbol/external/unresolved nodes and their edges.
 * Same staging semantics as files and structural nodes (ADR-0015): rows unchanged since the base revision are
 * kept, changed rows are closed and re-inserted, rows that disappeared are closed. Row identity:
 *  - a node is its node_id; a version is its canonical JSON (`data`);
 *  - an edge is (type, from, to, site) (KNOWLEDGE_GRAPH_DESIGN §4); a version is its canonical JSON.
 * Staging refuses what can never be valid (duplicate ids, unknown files, endpoints with no identity); the
 * validator checks what depends on visibility at a seq (KG-001, SY-002, SY-005, SY-006, WS-001).
 */
import type Database from 'better-sqlite3';
import {
  formatProducer,
  importEdgeViolations,
  relationViolations,
  type CanonicalPath,
  type ContentHash,
  type StoredSpan,
  type CodeEdge,
  type CodeGraph,
  type CodeNode,
  type NodeId,
  type StageStats,
  type StructuralEdge,
} from '@cie/core';
import type { VisibleAt } from './structure-store.js';

export const CODE_KINDS_SQL = "('module','symbol','external','unresolved')";

export interface GraphStageStats {
  readonly nodes: StageStats;
  readonly edges: StageStats;
}

/** Thrown inside the staging transaction so partial writes roll back; mapped to a Result by the store. */
export class GraphStagingError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details: Readonly<Record<string, unknown>>,
  ) {
    super(message);
  }
}

const identity = (e: Pick<CodeEdge, 'type' | 'from' | 'to' | 'site'>): string => `${e.type}\u0000${e.from}\u0000${e.to}\u0000${e.site}`;
const byString = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

interface VersionRow {
  id: number;
  ident: string;
  data: string;
}

function baseNodes(db: Database.Database, visibleAt: VisibleAt, seq: number | null): Map<string, VersionRow> {
  if (seq === null) return new Map();
  const rows = db
    .prepare(`select n.id, k.node_id as ident, n.data from node n join node_key k on k.key = n.node_key where ${visibleAt('n')} and n.kind in ${CODE_KINDS_SQL}`)
    .all({ seq }) as VersionRow[];
  return new Map(rows.map((r) => [r.ident, r]));
}

function baseEdges(db: Database.Database, visibleAt: VisibleAt, seq: number | null): Map<string, VersionRow> {
  if (seq === null) return new Map();
  const rows = db
    .prepare(
      `select e.id, e.type || char(0) || f.node_id || char(0) || t.node_id || char(0) || e.site_key as ident, e.data
       from edge e join node_key f on f.key = e.from_key join node_key t on t.key = e.to_key where ${visibleAt('e')}`,
    )
    .all({ seq }) as VersionRow[];
  return new Map(rows.map((r) => [r.ident, r]));
}

class Keys {
  private readonly fileKeyOf;
  private readonly nodeKeyOf;
  private readonly addNodeKey;

  constructor(db: Database.Database) {
    this.fileKeyOf = db.prepare('select key from file_key where path = ?').pluck();
    this.nodeKeyOf = db.prepare('select key, kind from node_key where node_id = ?');
    this.addNodeKey = db.prepare('insert into node_key (node_id, kind) values (?, ?)');
  }

  file(path: CanonicalPath, owner: string): number {
    const key = this.fileKeyOf.get(path) as number | undefined;
    if (key === undefined) throw new GraphStagingError('WS_001_UNKNOWN_FILE', `${owner} references ${path}, which the store does not know (WS-001)`, { owner, file: path });
    return key;
  }

  node(id: NodeId, kind: string | null): number {
    const row = this.nodeKeyOf.get(id) as { key: number; kind: string } | undefined;
    if (row !== undefined) {
      if (kind !== null && row.kind !== kind) throw new GraphStagingError('NODE_KIND_CONFLICT', `${id} is a ${row.kind}, not a ${kind}`, { node: id });
      return row.key;
    }
    if (kind === null) throw new GraphStagingError('KG_001_UNKNOWN_NODE', `an edge endpoint ${id} has no node identity (KG-001)`, { node: id });
    return Number(this.addNodeKey.run(id, kind).lastInsertRowid);
  }
}

function checkUnique(graph: CodeGraph): void {
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (ids.has(n.id)) throw new GraphStagingError('SY_002_DUPLICATE_NODE', `node ${n.id} is staged twice (SY-002)`, { node: n.id });
    ids.add(n.id);
  }
  const edges = new Set<string>();
  for (const e of graph.edges) {
    const k = identity(e);
    if (edges.has(k)) throw new GraphStagingError('SY_002_DUPLICATE_EDGE', `edge ${e.type} ${e.from} -> ${e.to} is staged twice`, { from: e.from, to: e.to, type: e.type });
    edges.add(k);
  }
}

const NO_SYMBOL = { qn: null, sk: null, sl: null, sc: null, el: null, ec: null, span: null, fp: null, exported: null, doc: null };

function symbolColumns(s: CodeNode['symbol']): Record<keyof typeof NO_SYMBOL, string | number | null> {
  if (s === null) return NO_SYMBOL;
  const r = s.range;
  return { qn: s.qualifiedName, sk: s.kind, sl: r.startLine, sc: r.startCol, el: r.endLine, ec: r.endCol, span: s.spanHash, fp: s.bodyFingerprint, exported: s.exported ? 1 : 0, doc: s.doc };
}

const NO_EVIDENCE = { evKind: null, evFile: null, sl: null, sc: null, el: null, ec: null, evHash: null };

function evidenceColumns(e: CodeEdge, keys: Keys): Record<keyof typeof NO_EVIDENCE, string | number | null> {
  const ev = e.evidence;
  if (ev === null) return NO_EVIDENCE;
  const r = ev.range;
  return { evKind: ev.kind, evFile: keys.file(ev.path, `${e.type} ${e.from} -> ${e.to}`), sl: r.startLine, sc: r.startCol, el: r.endLine, ec: r.endCol, evHash: ev.contentHash };
}

function stageGraphNodes(db: Database.Database, keys: Keys, seq: number, base: Map<string, VersionRow>, nodes: readonly CodeNode[]): StageStats {
  const stats = { inserted: 0, closed: 0, unchanged: 0 };
  const close = db.prepare('update node set valid_to_seq = ? where id = ? and valid_to_seq is null');
  const insert = db.prepare(
    `insert into node (node_key, kind, name, file_key, lang, qualified_name, symbol_kind, start_line, start_col, end_line, end_col,
                       span_hash, body_fingerprint, exported, doc, producer, fidelity, data, valid_from_seq)
     values (@key, @kind, @name, @file, @lang, @qn, @sk, @sl, @sc, @el, @ec, @span, @fp, @exported, @doc, @producer, @fidelity, @data, @seq)`,
  );
  for (const n of nodes) {
    const data = JSON.stringify(n);
    const old = base.get(n.id);
    base.delete(n.id);
    if (old !== undefined && old.data === data) {
      stats.unchanged++;
      continue;
    }
    if (old !== undefined) {
      close.run(seq, old.id);
      stats.closed++;
    }
    insert.run({
      key: keys.node(n.id, n.kind),
      kind: n.kind,
      name: n.name,
      file: n.file === null ? null : keys.file(n.file, n.id),
      lang: n.language,
      ...symbolColumns(n.symbol),
      producer: formatProducer(n.producer),
      fidelity: n.producer.fidelity,
      data,
      seq,
    });
    stats.inserted++;
  }
  for (const removed of base.values()) {
    close.run(seq, removed.id);
    stats.closed++;
  }
  return stats;
}

function stageGraphEdges(db: Database.Database, keys: Keys, seq: number, base: Map<string, VersionRow>, edges: readonly CodeEdge[]): StageStats {
  const stats = { inserted: 0, closed: 0, unchanged: 0 };
  const close = db.prepare('update edge set valid_to_seq = ? where id = ? and valid_to_seq is null');
  const insert = db.prepare(
    `insert into edge (type, from_key, to_key, site_key, status, precision, producer, fidelity, ev_kind, ev_file_key,
                       ev_start_line, ev_start_col, ev_end_line, ev_end_col, ev_content_hash, data, valid_from_seq)
     values (@type, @from, @to, @site, @status, @precision, @producer, @fidelity, @evKind, @evFile, @sl, @sc, @el, @ec, @evHash, @data, @seq)`,
  );
  for (const e of edges) {
    const ident = identity(e);
    const data = JSON.stringify(e);
    const old = base.get(ident);
    base.delete(ident);
    if (old !== undefined && old.data === data) {
      stats.unchanged++;
      continue;
    }
    if (old !== undefined) {
      close.run(seq, old.id);
      stats.closed++;
    }
    insert.run({
      type: e.type,
      from: keys.node(e.from, null),
      to: keys.node(e.to, null),
      site: e.site,
      status: e.status,
      precision: e.precision,
      producer: formatProducer(e.producer),
      fidelity: e.producer.fidelity,
      ...evidenceColumns(e, keys),
      data,
      seq,
    });
    stats.inserted++;
  }
  for (const removed of base.values()) {
    close.run(seq, removed.id);
    stats.closed++;
  }
  return stats;
}

/**
 * Records the line count of every extracted file on its file version (SY-003 a). The line count is a pure
 * function of the content hash, so a row carried from the base already holds the right value. A row this
 * revision introduced is still unpublished and is completed in place. A carried row without the value (its
 * file was never extracted before) is not updated: it is closed and re-versioned at `seq` (SN-007).
 */
function stageFileFacts(db: Database.Database, visibleAt: VisibleAt, seq: number, files: CodeGraph['files']): void {
  const find = db.prepare(
    `select f.id, f.file_key, f.status, f.hash, f.size, f.lang, f.line_count, f.valid_from_seq
     from file f join file_key k on k.key = f.file_key where k.path = @path and ${visibleAt('f')}`,
  );
  const complete = db.prepare('update file set line_count = ? where id = ?');
  const close = db.prepare('update file set valid_to_seq = ? where id = ? and valid_to_seq is null');
  const reversion = db.prepare("insert into file (file_key, status, hash, skip_reason, size, lang, line_count, valid_from_seq) values (?, 'indexed', ?, null, ?, ?, ?, ?)");
  for (const f of files) {
    const row = find.get({ path: f.path, seq }) as
      | { id: number; file_key: number; status: string; hash: string | null; size: number; lang: string | null; line_count: number | null; valid_from_seq: number }
      | undefined;
    if (row === undefined || row.status !== 'indexed') {
      throw new GraphStagingError('WS_001_UNKNOWN_FILE', `the code graph has facts for ${f.path}, which is not an indexed file of this revision (WS-001)`, { file: f.path });
    }
    if (row.hash !== f.contentHash) {
      throw new GraphStagingError('SY_003_CONTENT_MISMATCH', `${f.path} was extracted from content ${f.contentHash}, but the manifest has ${row.hash} (SY-003)`, { file: f.path });
    }
    if (!Number.isSafeInteger(f.lineCount) || f.lineCount < 1) {
      throw new GraphStagingError('SY_003_LINE_COUNT_INVALID', `${f.path} has an invalid line count ${f.lineCount}`, { file: f.path });
    }
    if (row.line_count === f.lineCount) continue;
    if (row.valid_from_seq === seq) {
      complete.run(f.lineCount, row.id);
      continue;
    }
    close.run(seq, row.id);
    reversion.run(row.file_key, row.hash, row.size, row.lang, f.lineCount, seq);
  }
}

/** Stages one revision's code graph. Call inside the store's write transaction; throws GraphStagingError. */
export function stageGraph(db: Database.Database, visibleAt: VisibleAt, seq: number, baseSeq: number | null, graph: CodeGraph): GraphStageStats {
  checkUnique(graph);
  stageFileFacts(db, visibleAt, seq, graph.files);
  const keys = new Keys(db);
  // Nodes first: edges may point at nodes introduced by this very revision.
  const nodes = stageGraphNodes(db, keys, seq, baseNodes(db, visibleAt, baseSeq), graph.nodes);
  const edges = stageGraphEdges(db, keys, seq, baseEdges(db, visibleAt, baseSeq), graph.edges);
  return { nodes, edges };
}

/** The code graph visible at `seq`, nodes sorted by id and edges by identity. */
export function selectGraph(db: Database.Database, visibleAt: VisibleAt, seq: number): { nodes: CodeNode[]; edges: CodeEdge[] } {
  const nodes = (db.prepare(`select n.data from node n where ${visibleAt('n')} and n.kind in ${CODE_KINDS_SQL}`).pluck().all({ seq }) as string[]).map(
    (d) => JSON.parse(d) as CodeNode,
  );
  const edges = (db.prepare(`select e.data from edge e where ${visibleAt('e')}`).pluck().all({ seq }) as string[]).map((d) => JSON.parse(d) as CodeEdge);
  nodes.sort((a, b) => byString(a.id, b.id));
  edges.sort((a, b) => byString(identity(a), identity(b)));
  return { nodes, edges };
}

function endpointViolations(db: Database.Database, visibleAt: VisibleAt, seq: number): string[] {
  const dangling = db
    .prepare(
      `select e.type, f.node_id as from_id, t.node_id as to_id,
              exists (select 1 from node n where n.node_key = e.from_key and ${visibleAt('n')}) as from_ok,
              exists (select 1 from node n where n.node_key = e.to_key and ${visibleAt('n')}) as to_ok
       from edge e join node_key f on f.key = e.from_key join node_key t on t.key = e.to_key
       where ${visibleAt('e')}`,
    )
    .all({ seq }) as Array<{ type: string; from_id: string; to_id: string; from_ok: number; to_ok: number }>;
  return dangling
    .filter((d) => d.from_ok === 0 || d.to_ok === 0)
    .map((d) => `KG-001: edge ${d.type} ${d.from_id} -> ${d.to_id} has an endpoint not visible at seq ${seq} (${d.from_ok === 0 ? d.from_id : d.to_id})`);
}

function duplicateViolations(db: Database.Database, visibleAt: VisibleAt, seq: number): string[] {
  const nodes = db
    .prepare(`select k.node_id from node n join node_key k on k.key = n.node_key where ${visibleAt('n')} group by n.node_key having count(*) > 1`)
    .pluck()
    .all({ seq }) as string[];
  const edges = db
    .prepare(`select e.type || ' ' || e.from_key || ' -> ' || e.to_key from edge e where ${visibleAt('e')} group by e.type, e.from_key, e.to_key, e.site_key having count(*) > 1`)
    .pluck()
    .all({ seq }) as string[];
  return [...nodes.map((id) => `SY-002: node ${id} is visible more than once at seq ${seq}`), ...edges.map((e) => `SY-002: edge ${e} is visible more than once at seq ${seq}`)];
}

function evidenceViolations(db: Database.Database, visibleAt: VisibleAt, seq: number): string[] {
  const orphans = db
    .prepare(
      `select e.type, fk.path from edge e join file_key fk on fk.key = e.ev_file_key
       where ${visibleAt('e')} and not exists (select 1 from file f where f.file_key = e.ev_file_key and ${visibleAt('f')})`,
    )
    .all({ seq }) as Array<{ type: string; path: string }>;
  return orphans.map((o) => `WS-001: ${o.type} edge evidence references ${o.path}, which is not visible at seq ${seq}`);
}

/** SY-005 and SY-006 over the stored rows (the schema enforces SY-005 too; this is the second layer). */
function attributionViolations(db: Database.Database, visibleAt: VisibleAt, seq: number): string[] {
  const out: string[] = [];
  const unattributed = db
    .prepare(`select count(*) from node n where ${visibleAt('n')} and n.kind in ${CODE_KINDS_SQL} and (n.producer is null or n.fidelity is null)`)
    .pluck()
    .get({ seq }) as number;
  if (unattributed > 0) out.push(`SY-005: ${unattributed} code node(s) at seq ${seq} have no producer`);
  const rows = db
    .prepare(`select e.data, t.kind as to_kind from edge e join node_key t on t.key = e.to_key where ${visibleAt('e')}`)
    .all({ seq }) as Array<{ data: string; to_kind: StructuralEdge['toKind'] }>;
  for (const r of rows) {
    const e = JSON.parse(r.data) as CodeEdge;
    if (e.type === 'imports' || e.type === 'imports_symbol') {
      const evidence = e.evidence ?? { kind: 'ast' as const, path: '' as CanonicalPath, range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 }, contentHash: '' as never };
      const attrs = { raw: String(e.attrs['raw'] ?? ''), name: (e.attrs['name'] ?? null) as string | null, isDynamic: e.attrs['isDynamic'] === true, isTypeOnly: e.attrs['isTypeOnly'] === true };
      out.push(...importEdgeViolations({ type: e.type, from: e.from, to: e.to, toKind: r.to_kind, status: e.status, precision: e.precision, producer: e.producer, evidence, attrs }));
    } else if (e.precision !== null) {
      out.push(`SY-006: ${e.type} ${e.from} -> ${e.to} is a syntactic edge but claims precision ${e.precision}`);
    }
  }
  return out;
}

/**
 * SY-003 (a) for every visible symbol, from the stored line count of its file version: the range is well
 * formed and ends on an existing line. Columns need the content; the span-hash sample covers them
 * (synchronization/application/span-check.ts).
 */
function boundsViolations(db: Database.Database, visibleAt: VisibleAt, seq: number): string[] {
  const rows = db
    .prepare(
      `select k.node_id as id, n.start_line as sl, n.start_col as sc, n.end_line as el, n.end_col as ec, f.line_count as lines
       from node n join node_key k on k.key = n.node_key
       left join file f on f.file_key = n.file_key and ${visibleAt('f')}
       where ${visibleAt('n')} and n.kind = 'symbol'
         and (f.line_count is null or n.end_line >= f.line_count or n.start_line < 0 or n.start_col < 0 or n.end_col is null or n.end_col < 0
              or n.start_line > n.end_line or (n.start_line = n.end_line and n.start_col > n.end_col))
       order by k.node_id`,
    )
    .all({ seq }) as Array<{ id: string; sl: number; sc: number; el: number; ec: number | null; lines: number | null }>;
  return rows.map((r) =>
    r.lines === null
      ? `SY-003: symbol ${r.id} has no line count for its file at seq ${seq}, so its range cannot be checked`
      : `SY-003: symbol ${r.id} range ${r.sl}:${r.sc}-${r.el}:${r.ec ?? '?'} is outside its file (${r.lines} line(s))`,
  );
}

/** KG-002 over the stored rows: registered type, endpoint kinds in the signature, allowed status, site key. */
function relationTypeViolations(db: Database.Database, visibleAt: VisibleAt, seq: number): string[] {
  const rows = db
    .prepare(
      `select e.type, e.status, e.site_key as site, f.kind as from_kind, t.kind as to_kind, f.node_id as from_id, t.node_id as to_id
       from edge e join node_key f on f.key = e.from_key join node_key t on t.key = e.to_key where ${visibleAt('e')}`,
    )
    .all({ seq }) as Array<{ type: string; status: string; site: string; from_kind: string; to_kind: string; from_id: string; to_id: string }>;
  return rows.flatMap((r) =>
    relationViolations({ type: r.type, fromKind: r.from_kind, toKind: r.to_kind, status: r.status, site: r.site }, `${r.type} ${r.from_id} -> ${r.to_id}`),
  );
}

export function graphViolations(db: Database.Database, visibleAt: VisibleAt, seq: number): string[] {
  return [
    ...endpointViolations(db, visibleAt, seq),
    ...relationTypeViolations(db, visibleAt, seq),
    ...duplicateViolations(db, visibleAt, seq),
    ...evidenceViolations(db, visibleAt, seq),
    ...attributionViolations(db, visibleAt, seq),
    ...boundsViolations(db, visibleAt, seq),
  ];
}

/**
 * A deterministic sample of the symbols visible at `seq` with what SY-003 (b) needs to rehash them: every
 * k-th symbol in node-id order, k = ceil(total / sample); `sample` null means all of them.
 */
export function sampleSymbolSpans(db: Database.Database, visibleAt: VisibleAt, seq: number, sample: number | null): { total: number; records: StoredSpan[] } {
  const total = db.prepare(`select count(*) from node n where ${visibleAt('n')} and n.kind = 'symbol'`).pluck().get({ seq }) as number;
  const step = sample === null || sample >= total ? 1 : Math.ceil(total / Math.max(1, sample));
  const rows = db
    .prepare(
      `select id, path, hash, sl, sc, el, ec, span from (
         select k.node_id as id, fk.path, f.hash, n.start_line as sl, n.start_col as sc, n.end_line as el, n.end_col as ec, n.span_hash as span,
                row_number() over (order by k.node_id) as rn
         from node n join node_key k on k.key = n.node_key
         join file_key fk on fk.key = n.file_key
         left join file f on f.file_key = n.file_key and ${visibleAt('f')}
         where ${visibleAt('n')} and n.kind = 'symbol')
       where (rn - 1) % @step = 0 order by rn`,
    )
    .all({ seq, step }) as Array<{ id: string; path: string; hash: string | null; sl: number; sc: number; el: number; ec: number; span: string }>;
  return {
    total,
    records: rows.map((r) => ({
      id: r.id,
      path: r.path as CanonicalPath,
      fileHash: r.hash as ContentHash | null,
      range: { startLine: r.sl, startCol: r.sc, endLine: r.el, endCol: r.ec },
      spanHash: r.span as ContentHash,
    })),
  };
}
