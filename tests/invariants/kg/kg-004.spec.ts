// KG-004: bounded traversal. Every GraphReadModel traversal requires maxDepth and limit, both clamped to the
// server caps, and reports truncated:true when a bound is hit. Cycle safety comes from UNION on (node,depth).
// Layers: the core clampBounds and the required-parameter types; the SQLite recursive CTE over a real graph.
import { clampBounds, DEFAULT_DEPTH, DEFAULT_LIMIT, graphQueries, MAX_DEPTH_CAP, MAX_LIMIT_CAP, weakerStatus, type GraphReadModel, type NodeId, type RevisionSeq } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeGraphOf } from '../../helpers/code-graph.js';
import { job, publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

async function writer() {
  const o = await sb.open();
  await o.store.lease.acquire('writer-1', 60_000);
  return o;
}

describe('KG-004: clampBounds and weakerStatus (domain)', () => {
  it('fills defaults and clamps to [1, cap]', () => {
    expect(clampBounds(undefined)).toEqual({ maxDepth: DEFAULT_DEPTH, limit: DEFAULT_LIMIT });
    expect(clampBounds({ maxDepth: 999, limit: 99999 })).toEqual({ maxDepth: MAX_DEPTH_CAP, limit: MAX_LIMIT_CAP });
    expect(clampBounds({ maxDepth: 0, limit: -5 })).toEqual({ maxDepth: 1, limit: 1 });
    expect(clampBounds({ maxDepth: 2.9, limit: 7.9 })).toEqual({ maxDepth: 2, limit: 7 });
    expect(clampBounds({ maxDepth: Number.NaN, limit: Number.POSITIVE_INFINITY })).toEqual({ maxDepth: DEFAULT_DEPTH, limit: DEFAULT_LIMIT });
  });

  it('weakerStatus takes the weaker of two statuses', () => {
    expect(weakerStatus('verified', 'inferred')).toBe('inferred');
    expect(weakerStatus('inferred', 'unknown')).toBe('unknown');
    expect(weakerStatus('verified', 'verified')).toBe('verified');
  });
});

/** A chain a -> b -> c -> d of imports plus a cycle e <-> f, as TS modules. */
const CHAIN = {
  'src/a.ts': "import { b } from './b';\nexport const a = b;\n",
  'src/b.ts': "import { c } from './c';\nexport const b = c;\n",
  'src/c.ts': "import { d } from './d';\nexport const c = d;\n",
  'src/d.ts': 'export const d = 1;\n',
  'src/e.ts': "import { f } from './f';\nexport const e = 1;\nexport const ee = f;\n",
  'src/f.ts': "import { e } from './e';\nexport const f = 1;\nexport const ff = e;\n",
};

describe('KG-004: the GraphReadModel traversal', () => {
  async function graph(): Promise<GraphReadModel & { seq: RevisionSeq }> {
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(CHAIN);
    const seq = await publishRevision(o, manifest, 0, graph);
    return Object.assign(o.store, { seq });
  }

  it('deps follows imports outward to maxDepth and stops there', async () => {
    const g = await graph();
    const q = graphQueries({ graph: g });
    const d1 = await q.deps(g.seq, 'mod:ts:src/a.ts' as NodeId, { maxDepth: 1 });
    const d3 = await q.deps(g.seq, 'mod:ts:src/a.ts' as NodeId, { maxDepth: 3 });
    if (!d1.ok || !d3.ok) throw new Error('query failed');
    expect(d1.value.found).toBe(true);
    expect(d1.value.nodes.some((n) => n.id === 'mod:ts:src/b.ts')).toBe(true);
    expect(d1.value.nodes.every((n) => n.depth === 1)).toBe(true);
    // At depth 3 the module chain b, c, d is reachable (imports_symbol adds the bound symbols too).
    expect(d3.value.nodes.filter((n) => n.id.startsWith('mod:')).map((n) => n.id).sort()).toEqual(['mod:ts:src/b.ts', 'mod:ts:src/c.ts', 'mod:ts:src/d.ts']);
    expect(Math.max(...d3.value.nodes.map((n) => n.depth))).toBeLessThanOrEqual(3);
  });

  it('reports truncated when the row limit is hit, and never exceeds it', async () => {
    const g = await graph();
    const q = graphQueries({ graph: g });
    const r = await q.deps(g.seq, 'mod:ts:src/a.ts' as NodeId, { maxDepth: 5, limit: 2 });
    if (!r.ok) throw new Error('query failed');
    expect(r.value.nodes).toHaveLength(2);
    expect(r.value.truncated).toBe(true);
  });

  it('terminates on a cycle (UNION on (node, depth))', async () => {
    const g = await graph();
    const q = graphQueries({ graph: g });
    const r = await q.deps(g.seq, 'mod:ts:src/e.ts' as NodeId, { maxDepth: MAX_DEPTH_CAP });
    if (!r.ok) throw new Error('query failed');
    expect(r.value.nodes.some((n) => n.id === 'mod:ts:src/f.ts')).toBe(true);
    expect(r.value.nodes.some((n) => n.id === 'mod:ts:src/e.ts')).toBe(true); // reachable back through the cycle
    expect(r.value.truncated).toBe(false); // finite despite the cycle
  });

  it('dependents follows imports inward', async () => {
    const g = await graph();
    const q = graphQueries({ graph: g });
    const r = await q.dependents(g.seq, 'mod:ts:src/d.ts' as NodeId, { maxDepth: MAX_DEPTH_CAP });
    if (!r.ok) throw new Error('query failed');
    expect(r.value.nodes.map((n) => n.id).filter((id) => id.startsWith('mod:')).sort()).toEqual(['mod:ts:src/a.ts', 'mod:ts:src/b.ts', 'mod:ts:src/c.ts']);
  });

  it('an unknown start node is found:false, not an error', async () => {
    const g = await graph();
    const q = graphQueries({ graph: g });
    const r = await q.deps(g.seq, 'mod:ts:src/ghost.ts' as NodeId);
    expect(r.ok && r.value).toEqual({ found: false, nodes: [], truncated: false });
  });

  it('neighbors groups one hop per type and caps each group', async () => {
    const o = await writer();
    const { manifest, graph: cg } = await codeGraphOf({
      'src/m.ts': "import { a } from './x';\nimport { b } from './x';\nexport function use() { return a() + b() }\n",
      'src/x.ts': 'export function a() { return 1 }\nexport function b() { return 2 }\n',
    });
    const seq = await publishRevision(o, manifest, 0, cg);
    const q = graphQueries({ graph: o.store });
    const r = await q.neighbors(seq, 'ts:src/m.ts#use(function)' as NodeId, 'out', ['calls'], 1);
    if (!r.ok) throw new Error('query failed');
    const calls = r.value.result.groups.find((g) => g.type === 'calls');
    expect(calls?.edges).toHaveLength(1);
    expect(calls?.truncated).toBe(true);
  });

  it('a read against an unpublished seq is refused', async () => {
    const o = await writer();
    const rev = await o.store.begin(null, job('j1'));
    if (!rev.ok) throw new Error(rev.error.code);
    const r = await o.store.traverse(rev.value.seq, { start: 'mod:ts:src/a.ts' as NodeId, direction: 'out', types: [], maxDepth: 1, limit: 10 });
    expect(r.ok === false && r.error.code).toBe('REVISION_NOT_VISIBLE');
  });
});
