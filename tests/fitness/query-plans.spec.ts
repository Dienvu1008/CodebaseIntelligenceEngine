// FF-PRF-004: bounded queries. Every read-model statement (traverse, neighbors, nodeExists, node key lookup and
// symbol search) is examined with EXPLAIN QUERY PLAN against a published graph:
//  - it must reach the revision-scoped tables (node, edge) through the expected named index, never by a scan;
//  - the only scans allowed are over the recursive working set, a windowed subquery's result and the FTS5
//    MATCH index, all of which are bounded by the statement's own limits;
//  - it must not build an automatic (throwaway) index, which would hide a missing persistent one.
// Two negative controls prove the checker is not vacuous: an unindexed statement is flagged, and so is a
// read-model statement run against a database whose edge_in index was dropped.
// Whole-revision exports (filesAt, structureAt, graphAt) read a full revision by contract and are not
// bounded queries; they are not in this list on purpose.
import path from 'node:path';
import { GRAPH_STATEMENTS, SEARCH_STATEMENTS, visibleAt } from '@cie/adapters';
import { exploreBudget } from '@cie/core';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { codeGraphOf } from '../helpers/code-graph.js';
import { publishRevision, sandbox, type Sandbox } from '../helpers/index-store.js';

/**
 * SCAN targets that are bounded by construction: the recursive CTE `reach` and its working set `r` (at most
 * exploreBudget(limit) rows, enforced inside the CTE), a subquery result, FTS5 MATCH. No table of the schema
 * is named here, so a scan of node, edge, file or claim is always flagged.
 */
const ALLOWED_SCAN = /^SCAN (CONSTANT ROW|reach\b|r\b|\(subquery-\d+\)|s VIRTUAL TABLE INDEX \d+:M\d+)/;

const sizeable = (n: number): Record<string, string> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, i) => [
      `src/m${i}.ts`,
      `${Array.from({ length: n }, (_, j) => (j === i ? '' : `import { v${j} } from './m${j}';`)).join('\n')}\nexport const v${i} = ${i};\nexport function f${i}() { return v${i} }\n`,
    ]),
  );

interface Statement {
  readonly name: string;
  readonly sql: string;
  /** The named index the plan must use on the revision-scoped table. */
  readonly index: RegExp;
}

const types = GRAPH_STATEMENTS.typeFilter(['calls', 'references']);
const STATEMENTS: readonly Statement[] = [
  { name: 'node key lookup', sql: GRAPH_STATEMENTS.nodeKey.replace('?', '@x'), index: /SEARCH node_key USING COVERING INDEX sqlite_autoindex_node_key_1/ },
  { name: 'node exists', sql: GRAPH_STATEMENTS.nodeExists(visibleAt), index: /SEARCH n USING INDEX node_key_vis/ },
  { name: 'traverse out', sql: GRAPH_STATEMENTS.traverse(visibleAt, 'out', ''), index: /SEARCH e USING INDEX edge_out/ },
  { name: 'traverse in', sql: GRAPH_STATEMENTS.traverse(visibleAt, 'in', ''), index: /SEARCH e USING INDEX edge_in/ },
  { name: 'traverse out, typed', sql: GRAPH_STATEMENTS.traverse(visibleAt, 'out', types.sql), index: /SEARCH e USING INDEX edge_out \(from_key=\? AND type=\?\)/ },
  { name: 'traverse in, typed', sql: GRAPH_STATEMENTS.traverse(visibleAt, 'in', types.sql), index: /SEARCH e USING INDEX edge_in \(to_key=\? AND type=\?\)/ },
  { name: 'neighbors out', sql: GRAPH_STATEMENTS.neighbors(visibleAt, 'out', ''), index: /SEARCH e USING INDEX edge_out/ },
  { name: 'neighbors in', sql: GRAPH_STATEMENTS.neighbors(visibleAt, 'in', ''), index: /SEARCH e USING INDEX edge_in/ },
  { name: 'neighbors out, typed', sql: GRAPH_STATEMENTS.neighbors(visibleAt, 'out', types.sql), index: /SEARCH e USING INDEX edge_out \(from_key=\? AND type=\?\)/ },
  { name: 'neighbors in, typed', sql: GRAPH_STATEMENTS.neighbors(visibleAt, 'in', types.sql), index: /SEARCH e USING INDEX edge_in \(to_key=\? AND type=\?\)/ },
  { name: 'symbol search', sql: SEARCH_STATEMENTS.search(visibleAt, 0), index: /SEARCH n USING INTEGER PRIMARY KEY \(rowid=\?\)/ },
  { name: 'symbol search, kind filter', sql: SEARCH_STATEMENTS.search(visibleAt, 2), index: /SEARCH n USING INTEGER PRIMARY KEY \(rowid=\?\)/ },
];

const PARAMS = { x: 'mod:ts:src/m0.ts', key: 1, start: 1, seq: 1, maxDepth: 3, limit: 10, budget: 50, q: '"f"*', t0: 'calls', t1: 'references', k0: 'function', k1: 'class' };

/** Problems found in the plan of `sql`: scans that are not bounded by construction, automatic indexes, a missing named index. */
function planProblems(db: Database.Database, s: Statement): string[] {
  const plan = (db.prepare(`explain query plan ${s.sql}`).all(PARAMS) as Array<{ detail: string }>).map((p) => p.detail);
  const problems = plan.filter((d) => d.startsWith('SCAN') && !ALLOWED_SCAN.test(d)).map((d) => `unbounded scan: ${d}`);
  problems.push(...plan.filter((d) => /AUTOMATIC/.test(d)).map((d) => `automatic index: ${d}`));
  if (!plan.some((d) => s.index.test(d))) problems.push(`expected ${s.index} in:\n${plan.join('\n')}`);
  return problems;
}

let sb: Sandbox;
let dbPath: string;
beforeAll(async () => {
  sb = await sandbox();
  const o = await sb.open();
  await o.store.lease.acquire('writer-1', 60_000);
  const { manifest, graph } = await codeGraphOf(sizeable(12));
  await publishRevision(o, manifest, 0, graph);
  dbPath = path.join(sb.stateDir, 'index.db');
});
afterAll(() => sb.dispose());

function withDb<T>(file: string, fn: (db: Database.Database) => T): T {
  const db = new Database(file, { readonly: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

describe('FF-PRF-004: read-model query plans', () => {
  it.each(STATEMENTS.map((s) => [s.name, s] as const))('%s uses its named index and scans no revision-scoped table', (_name, s) => {
    expect(withDb(dbPath, (db) => planProblems(db, s))).toEqual([]);
  });

  it('the checker flags an unindexed statement (negative control)', () => {
    const scan: Statement = { name: 'edge by status', sql: "select count(*) from edge where status = 'verified'", index: /SEARCH e USING INDEX/ };
    const problems = withDb(dbPath, (db) => planProblems(db, scan));
    expect(problems.some((p) => p.startsWith('unbounded scan: SCAN'))).toBe(true);
  });

  it('the checker flags a read-model statement when its index is missing (negative control)', async () => {
    // A copy of the database with edge_in dropped: the incoming traversal must no longer pass.
    const copy = path.join(sb.dir, 'no-edge-in.db');
    withDb(dbPath, (db) => db.exec(`vacuum into '${copy.replace(/'/g, "''")}'`));
    const rw = new Database(copy);
    rw.exec('drop index edge_in');
    rw.close();
    const traverseIn = STATEMENTS.find((s) => s.name === 'traverse in');
    if (traverseIn === undefined) throw new Error('fixture');
    const problems = withDb(copy, (db) => planProblems(db, traverseIn));
    expect(problems.length).toBeGreaterThan(0);
    expect(withDb(copy, (db) => planProblems(db, STATEMENTS.find((s) => s.name === 'traverse out') as Statement))).toEqual([]); // edge_out is untouched
  });
});

describe('FF-PRF-004: a traversal does bounded work', () => {
  it('explores at most exploreBudget(limit) states on a dense graph, where an unbudgeted walk explores far more', () => {
    withDb(dbPath, (db) => {
      const start = db.prepare("select key from node_key where node_id = 'mod:ts:src/m0.ts'").pluck().get() as number;
      const seq = db.prepare('select current_seq from workspace_head').pluck().get() as number;
      const run = (budget: number) =>
        db
          .prepare(GRAPH_STATEMENTS.traverse(visibleAt, 'out', ''))
          .all({ start, seq, maxDepth: 10, limit: 6, budget }) as Array<{ explored: number }>;
      const bounded = run(exploreBudget(5));
      const unbounded = run(1_000_000);
      expect(bounded[0]?.explored).toBe(exploreBudget(5)); // the budget is what stopped it
      expect(unbounded[0]?.explored).toBeGreaterThan(exploreBudget(5) * 3);
    });
  });
});
