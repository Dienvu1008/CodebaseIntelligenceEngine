// KG-003: structural nodes are backed. Every structural code node (module, symbol) at seq S has a backing
// file visible at S, and its stored kind agrees with the identity recorded on its node_key. external and
// unresolved nodes have no backing file. Concept and architecture nodes are not structural (Phase 04+).
// Two layers: the node-table CHECK forbids a null file_key for module/symbol at staging; the RevisionValidator
// adds visibility (the file may be closed at this seq) and kind consistency.
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CodeGraph, CodeNode } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeGraphOf } from '../../helpers/code-graph.js';
import { cseq, job, publishRevision, sandbox, stageAll, type Sandbox } from '../../helpers/index-store.js';

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
  'src/a.ts': "import { b } from './b';\nexport function a() { return b() }\n",
  'src/b.ts': 'export function b() { return 1; }\n',
};

/** Stages `graph` on a fresh revision with `FILES`, marks it validating, returns its KG-003 violations and publish result. */
async function attempt(transform: (g: CodeGraph) => CodeGraph): Promise<{ violations: readonly string[]; code: string | null }> {
  const o = await writer();
  const { manifest, graph } = await codeGraphOf(FILES);
  const rev = await o.store.begin(null, job('j1'));
  if (!rev.ok) throw new Error(rev.error.code);
  await stageAll(o, rev.value.seq, manifest, transform(graph));
  await o.store.markValidating(rev.value.seq);
  const violations = (await o.store.validate(rev.value.seq)).filter((v) => v.startsWith('KG-003:'));
  const published = await o.store.publish(rev.value.seq, cseq(0));
  return { violations, code: published.ok ? null : published.error.code };
}

describe('KG-003: the RevisionValidator', () => {
  it('publishes a projected graph: every module and symbol is backed by a visible file', async () => {
    expect(await attempt((g) => g)).toEqual({ violations: [], code: null });
  });

  it('aborts the publish when a symbol node loses the file version it is backed by', async () => {
    // Keep the node but drop every file whose version backs it: close src/b.ts across the revision by
    // publishing a1 with both files, then a2 that keeps the b-symbol node while b.ts is gone.
    const o = await writer();
    const v1 = await codeGraphOf(FILES);
    const rev1 = await o.store.begin(null, job('j1'));
    if (!rev1.ok) throw new Error(rev1.error.code);
    await stageAll(o, rev1.value.seq, v1.manifest, v1.graph);
    await o.store.markValidating(rev1.value.seq);
    expect((await o.store.publish(rev1.value.seq, cseq(0))).ok).toBe(true);

    // Revision 2: drop b.ts from the manifest but keep b's symbol node and module node.
    const manifest2 = v1.manifest.filter((e) => e.path !== 'src/b.ts');
    const keptBNodes = v1.graph.nodes.filter((n) => n.file === 'src/b.ts');
    const rev2 = await o.store.begin(rev1.value.seq, job('j2'));
    if (!rev2.ok) throw new Error(rev2.error.code);
    await o.store.stageManifest(rev2.value.seq, manifest2);
    await o.store.stageStructure(rev2.value.seq, []);
    // Only a.ts's nodes plus the orphaned b.ts nodes; edges dropped to isolate the KG-003 check from KG-001.
    const nodes = v1.graph.nodes.filter((n) => n.file === 'src/a.ts' || n.file === 'src/b.ts');
    const r = await o.store.stageGraph(rev2.value.seq, { nodes, edges: [], files: v1.graph.files.filter((f) => f.path === 'src/a.ts'), diagnostics: [] });
    expect(r.ok).toBe(true);
    await o.store.markValidating(rev2.value.seq);
    const violations = (await o.store.validate(rev2.value.seq)).filter((v) => v.startsWith('KG-003:'));
    expect(violations.length).toBe(keptBNodes.length);
    expect(violations.every((v) => v.includes('no backing file visible'))).toBe(true);
    const published = await o.store.publish(rev2.value.seq, cseq(0));
    expect(published.ok === false && published.error.code).toBe('PUBLISH_VALIDATION_FAILED');
    expect((await o.store.head())?.seq).toBe(rev1.value.seq);
  });

  it('refuses at staging a module or symbol node with no backing file at all (node-table CHECK)', async () => {
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(FILES);
    const rev = await o.store.begin(null, job('j1'));
    if (!rev.ok) throw new Error(rev.error.code);
    await o.store.stageManifest(rev.value.seq, manifest);
    await o.store.stageStructure(rev.value.seq, []);
    // The node-table CHECK (kind not in ('module','symbol') or file_key is not null) rejects it as a raw
    // constraint error, so staging throws rather than returning a Result: the row can never be written.
    const stripFile = (n: CodeNode): CodeNode => (n.kind === 'symbol' ? { ...n, file: null } : n);
    await expect(o.store.stageGraph(rev.value.seq, { ...graph, nodes: graph.nodes.map(stripFile), edges: [] })).rejects.toThrow(/CHECK constraint/);
  });

  it('external and unresolved nodes need no backing file', async () => {
    const files = { 'src/a.ts': "import fs from 'node:fs';\nimport { x } from 'pkg';\nexport const y = fs;\n" };
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(files);
    expect(graph.nodes.some((n) => n.kind === 'external' && n.file === null)).toBe(true);
    const rev = await o.store.begin(null, job('j1'));
    if (!rev.ok) throw new Error(rev.error.code);
    await stageAll(o, rev.value.seq, manifest, graph);
    await o.store.markValidating(rev.value.seq);
    expect((await o.store.validate(rev.value.seq)).filter((v) => v.startsWith('KG-003:'))).toEqual([]);
    expect((await o.store.publish(rev.value.seq, cseq(0))).ok).toBe(true);
  });

  it('refuses at staging a node whose kind disagrees with its identity (NODE_KIND_CONFLICT)', async () => {
    // node_key records an id with its kind the first time it is seen; re-staging the same id with a
    // different kind is a NODE_KIND_CONFLICT before any row is written. The validator's kind check (below)
    // is the second layer, for rows that somehow reach storage already mismatched.
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(FILES);
    const rev = await o.store.begin(null, job('j1'));
    if (!rev.ok) throw new Error(rev.error.code);
    await stageAll(o, rev.value.seq, manifest, graph); // establishes every node_key with its real kind
    const sym = graph.nodes.find((n) => n.kind === 'symbol');
    if (sym === undefined) throw new Error('expected a symbol');
    await o.store.markValidating(rev.value.seq);
    if (!(await o.store.publish(rev.value.seq, cseq(0))).ok) throw new Error('publish');
    const rev2 = await o.store.begin(rev.value.seq, job('j2'));
    if (!rev2.ok) throw new Error(rev2.error.code);
    await o.store.stageManifest(rev2.value.seq, manifest);
    await o.store.stageStructure(rev2.value.seq, []);
    const relabelled = graph.nodes.map((n) => (n.id === sym.id ? ({ ...n, kind: 'module' as const, symbol: null, file: sym.file } as CodeNode) : n));
    const r = await o.store.stageGraph(rev2.value.seq, { ...graph, nodes: relabelled, edges: [] });
    expect(r.ok === false && r.error.code).toBe('NODE_KIND_CONFLICT');
  });

  it('the validator flags a stored node whose kind was corrupted to disagree with its identity', async () => {
    // Second layer: tamper with node.kind directly in the database and confirm the RevisionValidator
    // reports KG-003, independently of the staging guard.
    const o = await writer();
    const { manifest, graph } = await codeGraphOf(FILES);
    const seq = await publishRevision(o, manifest, 0, graph);
    const db = new Database(path.join(sb.stateDir, 'index.db'));
    const sym = graph.nodes.find((n) => n.kind === 'symbol');
    if (sym === undefined) throw new Error('expected a symbol');
    db.prepare("update node set kind = 'module' where node_key = (select key from node_key where node_id = ?)").run(sym.id);
    db.close();
    const reopened = await sb.open();
    const violations = (await reopened.store.validate(seq)).filter((v) => v.startsWith('KG-003:'));
    expect(violations).toEqual([`KG-003: code node ${sym.id} has a node kind that disagrees with its identity`]);
  });
});
