// FF-DAT-001 (referential integrity) and FF-DAT-002 (workspace isolation) on real indexes produced by the CLI.
// FF-DAT-004 (revision digest stability, atomic visibility) is covered by tests/invariants/sn/sn-003 and
// sn-007; FF-DAT-005 by packages/adapters/test/sqlite/state-migrations.spec.ts.
import { cpSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { cliWorkspace, runCli } from '../helpers/cli.js';

const a = cliWorkspace({ 'package.json': '{}', 'src/a.ts': 'export const a = 1;\n', 'lib/pkg/__init__.py': '' });
const b = cliWorkspace({ 'src/b.ts': 'export const b = 2;\n' });
afterAll(() => {
  a.dispose();
  b.dispose();
});

describe('FF-DAT-001: referential integrity', () => {
  it('leaves an index with foreign keys enforced and zero foreign-key violations', () => {
    expect(runCli(['dev', 'index', ...a.args()], a.env()).code).toBe(0);
    expect(runCli(['dev', 'index', ...a.args()], a.env()).code).toBe(0); // a second revision on top
    const db = new Database(path.join(a.workspace, '.cie', 'index.db'), { readonly: true });
    try {
      db.pragma('foreign_keys = ON');
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      db.close();
    }
  });
});

describe('FF-DAT-002: workspace isolation', () => {
  it('keeps two workspaces apart and refuses a state directory copied from another workspace', () => {
    expect(runCli(['dev', 'index', ...a.args()], a.env()).code).toBe(0);
    expect(runCli(['dev', 'index', ...b.args()], b.env()).code).toBe(0);
    const exportOf = (w: typeof a) => (JSON.parse(runCli(['dev', 'export', ...w.args()], w.env()).stdout) as { files: Array<{ path: string }> }).files.map((f) => f.path);
    expect(exportOf(a)).not.toContain('src/b.ts');
    expect(exportOf(b)).toEqual(['src/b.ts']);

    // Copy B's index database (bound to B's id) into A's state directory: A must refuse it, not read B's data.
    cpSync(path.join(b.workspace, '.cie', 'index.db'), path.join(a.workspace, '.cie', 'index.db'));
    const r = runCli(['dev', 'status', ...a.args()], a.env());
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('STORE_WORKSPACE_MISMATCH');
  });
});
