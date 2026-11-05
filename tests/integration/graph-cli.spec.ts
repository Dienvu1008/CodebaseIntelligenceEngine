// P03-10: `cie dev deps|refs|impact|neighbors <node-id>` on the ts-relations fixture (text and JSON, bounds,
// direction, unknown nodes, usage errors). The node id is passed as a real process argument.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLI_TEST_TIMEOUT_MS, runCli } from '../helpers/cli.js';
import { repoPath } from '../helpers/repo.js';

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS, hookTimeout: CLI_TEST_TIMEOUT_MS });

const scratch = mkdtempSync(path.join(tmpdir(), 'cie-graph-cli-'));
const env = { CIE_CONFIG_DIR: path.join(scratch, 'user-config') };
const args = ['--workspace', repoPath('fixtures/ts-relations'), '--state-dir', path.join(scratch, 'ts-relations')];
const cli = (...rest: string[]) => runCli(['dev', ...rest, ...args], env);

beforeAll(() => {
  const r = runCli(['dev', 'index', ...args], env);
  if (r.code !== 0) throw new Error(r.stderr);
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Traversal {
  node: string;
  found: boolean;
  nodes: { id: string; depth: number; status: string }[];
  truncated: boolean;
}

describe('cie dev deps / dependents / refs / impact', () => {
  it('deps follows imports out of a module', () => {
    const r = JSON.parse(cli('deps', 'mod:ts:src/main.ts', '--json').stdout) as Traversal;
    expect(r.found).toBe(true);
    expect(r.nodes.map((n) => n.id)).toContain('mod:ts:src/shapes.ts');
    expect(r.nodes.every((n) => n.status === 'verified')).toBe(true);
  });

  it('refs is one hop of incoming references and calls', () => {
    const r = JSON.parse(cli('refs', 'ts:src/shapes.ts#total(function)', '--json').stdout) as Traversal;
    expect(r.nodes.map((n) => n.id)).toEqual(['ts:src/main.ts#main(function)']);
    expect(r.nodes.every((n) => n.depth === 1)).toBe(true);
  });

  it('impact closes over reference, call and type edges', () => {
    const r = JSON.parse(cli('impact', 'ts:src/shapes.ts#Shape(interface)', '--json').stdout) as Traversal;
    // main, total, User's fields etc. reference the Shape interface; everything within depth 3.
    expect(r.nodes.length).toBeGreaterThan(0);
    expect(Math.max(...r.nodes.map((n) => n.depth))).toBeLessThanOrEqual(3);
  });

  it('honours --depth and --limit and reports truncation in text output', () => {
    const limited = JSON.parse(cli('impact', 'ts:src/shapes.ts#Shape(interface)', '--limit', '1', '--json').stdout) as Traversal;
    expect([limited.nodes.length, limited.truncated]).toEqual([1, true]);
    expect(cli('impact', 'ts:src/shapes.ts#Shape(interface)', '--limit', '1').stdout).toContain('… more');
    const depth1 = JSON.parse(cli('deps', 'mod:ts:src/main.ts', '--depth', '1', '--json').stdout) as Traversal;
    expect(depth1.nodes.every((n) => n.depth === 1)).toBe(true);
  });

  it('prints text output with depth and status', () => {
    const out = cli('refs', 'ts:src/shapes.ts#total(function)').stdout;
    expect(out).toContain('ts:src/main.ts#main(function)');
    expect(out).toContain('[depth 1, verified]');
  });

  it('reports an unknown node as not found (exit 0), and a known node with no edges', () => {
    const ghost = JSON.parse(cli('deps', 'mod:ts:src/ghost.ts', '--json').stdout) as Traversal;
    expect(ghost.found).toBe(false);
    expect(cli('deps', 'mod:ts:src/ghost.ts').stdout).toContain('node not found');
    const leaf = JSON.parse(cli('deps', 'ts:src/shapes.ts#Shape.area(method)', '--json').stdout) as Traversal;
    expect([leaf.found, leaf.nodes.length]).toEqual([true, 0]);
  });
});

interface Neighbors {
  node: string;
  found: boolean;
  direction: string;
  groups: { type: string; edges: { node: string; status: string; precision: string | null }[]; truncated: boolean }[];
}

describe('cie dev neighbors', () => {
  it('groups one hop out by type with precision', () => {
    const r = JSON.parse(cli('neighbors', 'ts:src/main.ts#main(function)', '--json').stdout) as Neighbors;
    expect(r.direction).toBe('out');
    const calls = r.groups.find((g) => g.type === 'calls');
    expect(calls?.edges.map((e) => e.node).sort()).toEqual(['ts:src/shapes.ts#Square(class)', 'ts:src/shapes.ts#total(function)']);
    expect(calls?.edges.every((e) => e.status === 'verified' && e.precision === 'exact')).toBe(true);
  });

  it('follows --direction in and filters by --type', () => {
    const r = JSON.parse(cli('neighbors', 'ts:src/shapes.ts#total(function)', '--direction', 'in', '--type', 'calls', '--json').stdout) as Neighbors;
    expect(r.direction).toBe('in');
    expect(r.groups.map((g) => g.type)).toEqual(['calls']);
    expect(r.groups[0]?.edges.map((e) => e.node)).toEqual(['ts:src/main.ts#main(function)']);
  });

  it('caps each type group at --limit and flags truncation', () => {
    const r = JSON.parse(cli('neighbors', 'ts:src/main.ts#main(function)', '--type', 'calls', '--limit', '1', '--json').stdout) as Neighbors;
    const calls = r.groups.find((g) => g.type === 'calls');
    expect([calls?.edges.length, calls?.truncated]).toEqual([1, true]);
  });
});

describe('usage and argument errors', () => {
  it('rejects a missing node id, a bad direction, and non-positive bounds with exit 2 / 1', () => {
    expect(runCli(['dev', 'deps', ...args], env).code).toBe(2); // no node id
    expect(cli('neighbors', 'mod:ts:src/main.ts', '--direction', 'sideways').code).toBe(1);
    expect(cli('deps', 'mod:ts:src/main.ts', '--depth', '0').code).toBe(1);
    expect(cli('impact', 'ts:src/shapes.ts#Shape(interface)', '--limit', 'x').code).toBe(1);
  });
});
