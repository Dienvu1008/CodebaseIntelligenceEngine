// KG-001: no dangling relations. For every edge visible at seq S, both endpoint nodes are visible at S, and
// removing a node in revision N closes all its incident edges in the same revision. Two independent layers:
//  - staging refuses an edge whose endpoint has no node identity at all (KG_001_UNKNOWN_NODE);
//  - validation refuses an edge whose endpoint identity exists but is not visible at this seq.
// End to end, deleting files across revisions never leaves an edge behind, and earlier revisions keep theirs.
import type { CodeGraph, NodeId } from '@cie/core';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeGraphOf, danglingEdges } from '../../helpers/code-graph.js';
import { cseq, EMPTY_GRAPH, job, publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

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

const FILES = {
  'src/a.ts': "import { b } from './b';\nexport function a() { return b }\n",
  'src/b.ts': 'export const b = 1;\nexport class B { m() {} }\n',
};

describe('KG-001: staging and validation', () => {
  it('refuses at staging an edge whose endpoint has no node identity, and writes nothing', async () => {
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(FILES);
    const rev = await o.store.begin(null, job('j1'));
    if (!rev.ok) throw new Error(rev.error.code);
    await o.store.stageManifest(rev.value.seq, manifest);
    await o.store.stageStructure(rev.value.seq, []);
    const [first] = graph.edges;
    if (first === undefined) throw new Error('expected edges');
    const ghost: CodeGraph = { ...graph, edges: [...graph.edges, { ...first, to: 'ts:src/ghost.ts#g(function)' as NodeId }] };
    const r = await o.store.stageGraph(rev.value.seq, ghost);
    expect(r.ok === false && r.error.code).toBe('KG_001_UNKNOWN_NODE');
    // The failed staging rolled back completely: the correct graph still stages, and publishes.
    expect((await o.store.stageGraph(rev.value.seq, graph)).ok).toBe(true);
    await o.store.markValidating(rev.value.seq);
    expect(await o.store.validate(rev.value.seq)).toEqual([]);
    expect((await o.store.publish(rev.value.seq, cseq(0))).ok).toBe(true);
  });

  it('refuses to publish an edge whose endpoint exists but is not visible at this seq', async () => {
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(FILES);
    const s1 = await publishRevision(o, manifest, 0, graph);
    // Revision 2 drops the class B node but keeps an edge that points at it.
    const removed = 'ts:src/b.ts#B(class)';
    const orphan: CodeGraph = { ...graph, nodes: graph.nodes.filter((n) => n.id !== removed && !n.id.startsWith(`${removed.slice(0, -7)}.`)) };
    const rev = await o.store.begin(s1, job('j2'));
    if (!rev.ok) throw new Error(rev.error.code);
    await o.store.stageManifest(rev.value.seq, manifest);
    await o.store.stageStructure(rev.value.seq, []);
    expect((await o.store.stageGraph(rev.value.seq, orphan)).ok).toBe(true);
    await o.store.markValidating(rev.value.seq);
    const violations = await o.store.validate(rev.value.seq);
    expect(violations.filter((v) => v.startsWith('KG-001:')).length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes(removed))).toBe(true);
    const published = await o.store.publish(rev.value.seq, cseq(0));
    expect(published.ok === false && published.error.code).toBe('PUBLISH_VALIDATION_FAILED');
    expect((await o.store.head())?.seq).toBe(s1);
  });
});

describe('KG-001: removing nodes closes their incident edges', () => {
  it('deleting a file removes its nodes and every edge touching them, and keeps the earlier revision intact', async () => {
    const o = await writer();
    const v1 = await codeGraphOf(FILES);
    const s1 = await publishRevision(o, v1.manifest, 0, v1.graph);
    const v2 = await codeGraphOf({ 'src/a.ts': FILES['src/a.ts'] }); // b.ts deleted: the import is now unresolved
    const s2 = await publishRevision(o, v2.manifest, 0, v2.graph);

    const g1 = await o.store.graphAt(s1);
    const g2 = await o.store.graphAt(s2);
    if (!g1.ok || !g2.ok) throw new Error('read failed');
    expect(danglingEdges(g1.value)).toEqual([]);
    expect(danglingEdges(g2.value)).toEqual([]);
    expect(g2.value.nodes.some((n) => n.file === 'src/b.ts' && n.kind !== 'unresolved')).toBe(false);
    expect(g2.value.edges.some((e) => e.to.includes('src/b.ts') || e.from.includes('src/b.ts'))).toBe(false);
    expect(g2.value.edges.some((e) => e.type === 'imports' && e.to.startsWith('unres:'))).toBe(true);
    // SN-007: the earlier revision still shows the import of b.ts.
    expect(g1.value.edges.some((e) => e.type === 'imports' && e.to === 'mod:ts:src/b.ts')).toBe(true);
  });

  it('never publishes a dangling edge across random edit sequences (property-based)', async () => {
    const names = ['a', 'b', 'c', 'd'];
    const workspace = fc.dictionary(
      fc.constantFrom(...names),
      fc.record({ imports: fc.subarray(names), exported: fc.boolean() }),
      { minKeys: 1, maxKeys: 4 },
    );
    const render = (w: Record<string, { imports: string[]; exported: boolean }>) =>
      Object.fromEntries(
        Object.entries(w).map(([n, f]) => [
          `src/${n}.ts`,
          `${f.imports.map((i) => `import { ${i} } from './${i}';`).join('\n')}\n${f.exported ? 'export ' : ''}function ${n}() {}\n`,
        ]),
      );
    await fc.assert(
      fc.asyncProperty(fc.array(workspace, { minLength: 1, maxLength: 3 }), async (steps) => {
        const o = await sb.open();
        await o.store.lease.acquire('writer-1', 60_000);
        for (const step of steps) {
          const { manifest, graph } = await codeGraphOf(render(step));
          const seq = await publishRevision(o, manifest, 0, graph);
          const g = await o.store.graphAt(seq);
          if (!g.ok) throw new Error(g.error.code);
          expect(danglingEdges(g.value)).toEqual([]);
        }
        // Reset to an empty revision so the next run starts from a clean head.
        await publishRevision(o, [], 0, EMPTY_GRAPH);
        o.close();
      }),
      { numRuns: 8 },
    );
  });
});
