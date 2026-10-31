// P02-08 end to end through `cie dev index`: extraction, resolution and the code graph are part of every
// published revision, a file the extractor cannot decode is skipped without failing the run, an unchanged
// workspace re-publishes without new graph rows, and `cie dev status` reports the capability matrix.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLI_TEST_TIMEOUT_MS, cliWorkspace, runCli } from '../helpers/cli.js';

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS });

let ws: ReturnType<typeof cliWorkspace> | undefined;
afterEach(() => ws?.dispose());

interface Outcome {
  seq: number;
  code: { extractedFiles: number; symbols: number; nodes: number; edges: number; skipped: { path: string; code: string }[] };
  graph: { nodes: { inserted: number; closed: number; unchanged: number }; edges: { inserted: number; closed: number; unchanged: number } };
}

const index = (w: NonNullable<typeof ws>): Outcome => {
  const r = runCli(['dev', 'index', '--json', ...w.args()], w.env());
  expect(r.code, r.stderr).toBe(0);
  return JSON.parse(r.stdout) as Outcome;
};

describe('code graph in the full index', () => {
  it('extracts, resolves and publishes; skips an undecodable file; re-publishes an unchanged graph as unchanged', () => {
    ws = cliWorkspace({
      'package.json': '{ "name": "demo", "dependencies": { "zod": "3" } }',
      'src/a.ts': "import { b } from './b';\nimport { z } from 'zod';\nexport function a() { return b }\n",
      'src/b.ts': 'export const b = 1;\n',
      'py/m.py': 'import os\ndef f():\n    pass\n',
    });
    ws.write('src/broken.ts', new Uint8Array([0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0xff, 0xfe, 0x0a])); // invalid UTF-8
    const first = index(ws);
    expect(first.code.extractedFiles).toBe(3);
    expect(first.code.skipped).toEqual([{ path: 'src/broken.ts', code: 'EXTRACTION_UNDECODABLE' }]);
    expect(first.code.symbols).toBe(3);
    expect(first.graph.nodes.inserted).toBe(first.code.nodes);
    expect(first.graph.edges.inserted).toBe(first.code.edges);

    const second = index(ws);
    expect(second.graph).toEqual({ nodes: { inserted: 0, closed: 0, unchanged: first.code.nodes }, edges: { inserted: 0, closed: 0, unchanged: first.code.edges } });

    ws.write('src/b.ts', 'export const b = 2;\nexport const c = 3;\n');
    const third = index(ws);
    expect(third.graph.nodes.inserted).toBeGreaterThan(0);
    expect(third.graph.nodes.closed).toBeGreaterThan(0);
  });

  it('keeps every edge one resolver emits for the same import site (package plus submodules)', () => {
    ws = cliWorkspace({ 'main.py': 'from app import models, util\n', 'app/__init__.py': '', 'app/models.py': '', 'app/util.py': '' });
    index(ws);
    const doc = JSON.parse(runCli(['dev', 'export', ...ws.args()], ws.env()).stdout) as { edges: { type: string; from: string; to: string }[] };
    expect(doc.edges.filter((e) => e.type === 'imports' && e.from === 'mod:py:main.py').map((e) => e.to)).toEqual([
      'mod:py:app/__init__.py',
      'mod:py:app/models.py',
      'mod:py:app/util.py',
    ]);
  });

  it('reports the capability matrix in dev status', () => {
    ws = cliWorkspace({ 'src/a.ts': 'export const a = 1;\n' });
    index(ws);
    const r = runCli(['dev', 'status', '--json', ...ws.args()], ws.env());
    expect(r.code, r.stderr).toBe(0);
    const status = JSON.parse(r.stdout) as { capabilities: Record<string, Record<string, string>> };
    expect(Object.keys(status.capabilities)).toEqual(['js', 'py', 'ts', 'tsx']);
    expect(status.capabilities['ts']).toMatchObject({ symbols: 'L1', imports: 'L3', docstrings: 'L1', references: 'L0' });
    expect(status.capabilities['py']).toMatchObject({ symbols: 'L1', imports: 'L2' });
  });
});
