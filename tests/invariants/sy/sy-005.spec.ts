// SY-005: producer attribution. Every symbol (every code node) and every structural edge records a ProducerRef
// {adapterId, adapterVersion, toolVersion, fidelity}, and the fidelity is the one the producer declares for the
// capability behind the fact: L1 symbols from tree-sitter, L3 TS imports from lang-ts, L2 Python imports from
// lang-python. The database refuses code rows without attribution, and the type system requires a producer.
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CodeNode, NodeId } from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codeGraphOf } from '../../helpers/code-graph.js';
import { publishRevision, sandbox, type Sandbox } from '../../helpers/index-store.js';

let sb: Sandbox;
beforeEach(async () => {
  sb = await sandbox();
});
afterEach(() => sb.dispose());

const FILES = {
  'src/a.ts': "import { b } from './b';\nimport fs from 'node:fs';\nexport class A { m() {} }\n",
  'src/b.ts': 'export const b = 1;\n',
  'pkg/__init__.py': '',
  'pkg/m.py': 'from . import n\nimport os\ndef f():\n    pass\n',
  'pkg/n.py': '',
};

async function published() {
  const o = await sb.open();
  await o.store.lease.acquire('writer-1', 60_000);
  const { manifest, graph } = await codeGraphOf(FILES);
  const seq = await publishRevision(o, manifest, 0, graph);
  const g = await o.store.graphAt(seq);
  if (!g.ok) throw new Error(g.error.code);
  return { o, g: g.value };
}

const complete = (p: { adapterId: string; adapterVersion: string; toolVersion: string; fidelity: string }) =>
  p.adapterId !== '' && p.adapterVersion !== '' && p.toolVersion !== '' && ['L0', 'L1', 'L2', 'L3'].includes(p.fidelity);

describe('SY-005: every code node and edge is attributed', () => {
  it('records a complete ProducerRef on every published node and edge', async () => {
    const { g } = await published();
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.edges.length).toBeGreaterThan(0);
    expect(g.nodes.filter((n) => !complete(n.producer)).map((n) => n.id)).toEqual([]);
    expect(g.edges.filter((e) => !complete(e.producer)).map((e) => `${e.type} ${e.from}`)).toEqual([]);
  });

  it('attributes each fact to the capability that produced it', async () => {
    const { g } = await published();
    const symbol = g.nodes.find((n) => n.id === 'ts:src/a.ts#A(class)');
    expect(symbol?.producer).toEqual({ adapterId: 'treesitter', adapterVersion: '0.1.0', toolVersion: 'web-tree-sitter@0.27.1+tree-sitter-typescript@0.23.2', fidelity: 'L1' });
    const tsImport = g.edges.find((e) => e.type === 'imports' && e.to === 'mod:ts:src/b.ts');
    expect(tsImport?.producer).toEqual({ adapterId: 'lang-ts', adapterVersion: '0.1.0', toolVersion: 'typescript@6.0.3', fidelity: 'L3' });
    const pyImport = g.edges.find((e) => e.type === 'imports' && e.to === 'mod:py:pkg/n.py');
    expect(pyImport?.producer).toMatchObject({ adapterId: 'lang-python', fidelity: 'L2' });
    const contains = g.edges.find((e) => e.type === 'contains');
    expect(contains?.producer.adapterId).toBe('treesitter');
    // External targets inherit the attribution of the edge that introduced them.
    expect(g.nodes.find((n) => n.id === 'ext:node:fs')?.producer.adapterId).toBe('lang-ts');
  });

  it('the database refuses code nodes and edges without producer or fidelity', async () => {
    const { o } = await published();
    o.close();
    const db = new Database(path.join(sb.stateDir, 'index.db'));
    try {
      expect(() =>
        db.exec("insert into node (node_key, kind, name, file_key, data, valid_from_seq) select node_key, 'module', name, file_key, data, 99 from node where kind = 'module' limit 1"),
      ).toThrow(/CHECK/);
      expect(() => db.exec('insert into edge (type, from_key, to_key, status, data, valid_from_seq) select type, from_key, to_key, status, data, 99 from edge limit 1')).toThrow(/NOT NULL/);
    } finally {
      db.close();
    }
  });

  it('a CodeNode cannot be built without a producer (type-level)', () => {
    // @ts-expect-error producer is required (SY-005)
    const node: CodeNode = { id: 'mod:ts:x.ts' as NodeId, kind: 'module', name: 'x.ts', file: null, language: null, symbol: null };
    expect(node.kind).toBe('module');
  });
});
