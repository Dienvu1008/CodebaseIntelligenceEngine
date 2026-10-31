// WS-001: source references belong to the workspace revision.
//  (a) structural records (nodes backed by a manifest file) reference a file visible at the same seq;
//  (b) explicit evidence/anchors (Phase 03+) reference a known file_key plus a content hash; tested there.
// Two independent layers: staging refuses a file the store has never seen, and validation refuses a file
// that is known but not visible at this seq. Either way, the revision cannot be published.
import { deriveStructure, type NodeId, type StructuralNode } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cpath, cseq, EMPTY_GRAPH, file, job, publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

const pkgNode = (manifest: string): StructuralNode => ({
  id: `pkg:npm:${manifest}` as NodeId,
  kind: 'package',
  name: 'x',
  ecosystem: 'npm',
  file: cpath(manifest),
});

describe('WS-001 (a): structural nodes reference files visible at the same revision', () => {
  it('refuses at staging a node whose backing file the store has never seen', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const rev = await o.store.begin(null, job('j1'));
    if (!rev.ok) throw new Error(rev.error.code);
    await o.store.stageManifest(rev.value.seq, [file('src/a.ts', 'a')]);
    const r = await o.store.stageStructure(rev.value.seq, [pkgNode('ghost/package.json')]);
    expect(r.ok === false && r.error.code).toBe('WS_001_UNKNOWN_FILE');
    // The failed staging rolled back completely, so a correct structure can still be staged.
    expect((await o.store.stageStructure(rev.value.seq, deriveStructure([file('src/a.ts', 'a')]))).ok).toBe(true);
  });

  it('refuses to publish a node whose backing file is known but removed in this revision', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const s1 = await publishRevision(o, [file('package.json', 'a', 1, null), file('src/a.ts', 'b')]);
    const rev = await o.store.begin(s1, job('j2'));
    if (!rev.ok) throw new Error(rev.error.code);
    await o.store.stageManifest(rev.value.seq, [file('src/a.ts', 'b')]); // package.json deleted...
    await o.store.stageStructure(rev.value.seq, [pkgNode('package.json')]); // ...but its node kept: orphan
    await o.store.stageGraph(rev.value.seq, EMPTY_GRAPH);
    await o.store.markValidating(rev.value.seq);
    const violations = await o.store.validate(rev.value.seq);
    expect(violations.some((v) => v.startsWith('WS-001: node pkg:npm:package.json'))).toBe(true);
    const published = await o.store.publish(rev.value.seq, cseq(0));
    expect(published.ok === false && published.error.code).toBe('PUBLISH_VALIDATION_FAILED');
    expect((await o.store.head())?.seq).toBe(s1);
  });

  it('keeps every published node consistent with the published manifest', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const entries = [file('package.json', 'a', 1, null), file('py/pkg/__init__.py', 'b', 1, 'py'), file('tsconfig.json', 'c', 1, null), file('src/x/y.ts', 'd')];
    const s = await publishRevision(o, entries);
    const files = await o.store.filesAt(s);
    const nodes = await o.store.structureAt(s);
    if (!files.ok || !nodes.ok) throw new Error('read failed');
    const paths = new Set(files.value.map((f) => f.path));
    for (const n of nodes.value) if (n.file !== null) expect(paths.has(n.file), n.id).toBe(true);
    expect(nodes.value.map((n) => n.id)).toEqual(['dir:py', 'dir:py/pkg', 'dir:src', 'dir:src/x', 'pkg:npm:.', 'pkg:py:py/pkg', 'proj:ts:tsconfig.json']);
  });
});
