// P02-09: `cie dev symbols <query>` on the committed fixtures (text and JSON output, kind filter, limits, usage
// errors). The query is passed as a real process argument, so shell-like or FTS5-like text is covered too.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLI_TEST_TIMEOUT_MS, runCli } from '../helpers/cli.js';
import { repoPath } from '../helpers/repo.js';

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS, hookTimeout: CLI_TEST_TIMEOUT_MS });

const scratch = mkdtempSync(path.join(tmpdir(), 'cie-symbols-'));
const env = { CIE_CONFIG_DIR: path.join(scratch, 'user-config') };
const args = (fixture: string) => ['--workspace', repoPath(`fixtures/${fixture}`), '--state-dir', path.join(scratch, fixture)];
const symbols = (fixture: string, ...rest: string[]) => runCli(['dev', 'symbols', ...rest, ...args(fixture)], env);

beforeAll(() => {
  for (const f of ['py-basic', 'py-src-layout']) {
    const r = runCli(['dev', 'index', ...args(f)], env);
    if (r.code !== 0) throw new Error(r.stderr);
  }
});
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

interface Hits {
  revision: number;
  hits: { id: string; kind: string; path: string; range: { startLine: number; startCol: number } }[];
  truncated: boolean;
}

describe('cie dev symbols', () => {
  it('prints matches with 1-based positions', () => {
    const r = symbols('py-basic', 'make_user');
    expect(r.code, r.stderr).toBe(0);
    expect(r.stdout).toBe('function    make_user  app/models.py:15:1\n');
  });

  it('returns JSON with 0-based ranges, honours --kind and --limit', () => {
    const all = JSON.parse(symbols('py-basic', 'user', '--json').stdout) as Hits;
    expect(all.hits.map((h) => h.id)).toEqual(['py:app/models.py#User(class)', 'py:app/models.py#make_user(function)', 'py:app/models.py#User.home(method)', 'py:app/models.py#User.name(property)']);
    expect(all.hits[0]?.range).toMatchObject({ startLine: 5, startCol: 0 });
    const methods = JSON.parse(symbols('py-basic', 'user', '--kind', 'method,property', '--json').stdout) as Hits;
    expect(methods.hits.map((h) => h.kind)).toEqual(['method', 'property']);
    const one = JSON.parse(symbols('py-basic', 'user', '--limit', '1', '--json').stdout) as Hits;
    expect([one.hits.length, one.truncated]).toEqual([1, true]);
    expect(symbols('py-basic', 'user', '--limit', '1').stdout).toContain('more results; raise --limit');
  });

  it('searches each workspace independently', () => {
    expect(symbols('py-src-layout', 'util').stdout).toBe('function    util_fn  src/pkg/helpers.py:4:1\n');
    expect(symbols('py-src-layout', 'make_user').stdout).toBe('no symbols match\n');
  });

  it('treats query text as data, and reports usage errors with exit code 2', () => {
    const odd = symbols('py-basic', '"; DROP TABLE node; NEAR(a) name:x');
    expect(odd.code, odd.stderr).toBe(0);
    expect(odd.stdout).toBe('no symbols match\n');
    expect(symbols('py-basic', '***').code).toBe(1); // SEARCH_QUERY_EMPTY is an operation error
    expect(runCli(['dev', 'symbols', ...args('py-basic')], env).code).toBe(2); // no query
    expect(symbols('py-basic', 'x', '--kind', 'banana').code).toBe(2);
    expect(symbols('py-basic', 'x', '--limit', '0').code).toBe(2);
    expect(runCli(['dev', 'status', 'extra', ...args('py-basic')], env).code).toBe(2);
  });
});
