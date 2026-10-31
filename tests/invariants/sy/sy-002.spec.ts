// SY-002: uniqueness within a revision. At any seq, no two visible symbol records (or any code nodes) share
// an id, and no two visible edges share an identity (type, from, to, site). Three layers:
//  - SymbolIdentity disambiguates colliding declarations (~n), so real extractions never collide;
//  - staging refuses duplicate ids or edge identities in one graph (SY_002_DUPLICATE_*);
//  - the database refuses a second head row per node key / edge identity (partial unique indexes), and the
//    validator reports any duplicate visible at a seq.
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CodeGraph } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeGraphOf } from '../../helpers/code-graph.js';
import { job, publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

const COLLIDING = {
  'src/over.ts': 'export function f(a: string): void;\nexport function f(a: number): void;\nexport function f(a) {}\nclass C { get v() { return 1 } set v(x) {} }\n',
  'pkg/redef.py': 'def g():\n    pass\n\ndef g():\n    pass\n',
};

async function stageOnly(graph: CodeGraph, manifestFiles: Parameters<typeof publishRevision>[1]) {
  const o = await sb.open();
  await o.store.lease.acquire('writer-1', 60_000);
  const rev = await o.store.begin(null, job('j1'));
  if (!rev.ok) throw new Error(rev.error.code);
  await o.store.stageManifest(rev.value.seq, manifestFiles);
  await o.store.stageStructure(rev.value.seq, []);
  return { o, seq: rev.value.seq, staged: await o.store.stageGraph(rev.value.seq, graph) };
}

describe('SY-002: identity uniqueness', () => {
  it('publishes colliding declarations (overloads, redeclarations) under distinct ids', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const { manifest, graph } = await codeGraphOf(COLLIDING);
    const seq = await publishRevision(o, manifest, 0, graph);
    const g = await o.store.graphAt(seq);
    if (!g.ok) throw new Error(g.error.code);
    const ids = g.value.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id.startsWith('ts:src/over.ts#f(function)'))).toEqual(['ts:src/over.ts#f(function)~1', 'ts:src/over.ts#f(function)~2', 'ts:src/over.ts#f(function)~3']);
    expect(ids.filter((id) => id.startsWith('py:pkg/redef.py#g('))).toEqual(['py:pkg/redef.py#g(function)~1', 'py:pkg/redef.py#g(function)~2']);
  });

  it('refuses a graph that stages the same node id or edge identity twice, writing nothing', async () => {
    const { manifest, graph } = await codeGraphOf(COLLIDING);
    const [n] = graph.nodes;
    const [e] = graph.edges;
    if (n === undefined || e === undefined) throw new Error('expected nodes and edges');
    const dupNode = await stageOnly({ ...graph, nodes: [...graph.nodes, n] }, manifest);
    expect(dupNode.staged.ok === false && dupNode.staged.error.code).toBe('SY_002_DUPLICATE_NODE');
    expect((await dupNode.o.store.stageGraph(dupNode.seq, graph)).ok).toBe(true); // rolled back: retry works
    dupNode.o.close();
    sb.dispose();
    sb = await sandbox();
    const dupEdge = await stageOnly({ ...graph, edges: [...graph.edges, { ...e, status: e.status }] }, manifest);
    expect(dupEdge.staged.ok === false && dupEdge.staged.error.code).toBe('SY_002_DUPLICATE_EDGE');
  });

  it('the database refuses a second head row for the same node key or edge identity', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const { manifest, graph } = await codeGraphOf(COLLIDING);
    await publishRevision(o, manifest, 0, graph);
    o.close();
    const db = new Database(path.join(sb.stateDir, 'index.db'));
    try {
      expect(() => db.exec('insert into node (node_key, kind, name, file_key, producer, fidelity, data, valid_from_seq) select node_key, kind, name, file_key, producer, fidelity, data, 99 from node where kind = \'module\' limit 1')).toThrow(/UNIQUE/);
      expect(() => db.exec('insert into edge (type, from_key, to_key, site_key, status, producer, fidelity, data, valid_from_seq) select type, from_key, to_key, site_key, status, producer, fidelity, data, 99 from edge limit 1')).toThrow(/UNIQUE/);
    } finally {
      db.close();
    }
  });
});
