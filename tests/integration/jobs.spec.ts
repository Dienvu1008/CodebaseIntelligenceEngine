// Job history across a crash (SN-005, P01-07): a job killed mid-run is marked failed by the next run's
// recovery, and the recovering job is recorded as succeeded.
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { cliWorkspace, runCli } from '../helpers/cli.js';

const ws = cliWorkspace({ 'src/a.ts': 'export const a = 1;\n' });
afterAll(() => ws.dispose());

const jobStates = (): string[] => {
  const db = new Database(path.join(ws.workspace, '.cie', 'state.db'), { readonly: true });
  try {
    return db.prepare('select state from job order by created_at_ms, rowid').pluck().all() as string[];
  } finally {
    db.close();
  }
};

describe('job history', () => {
  it('records succeeded jobs, and marks a crashed job failed on the next run', () => {
    expect(runCli(['dev', 'index', ...ws.args()], ws.env()).code).toBe(0);
    expect(jobStates()).toEqual(['succeeded']);
    runCli(['dev', 'index', ...ws.args()], { ...ws.env(), CIE_TEST_HOOKS: '1', CIE_TEST_KILL_AT: 'staged' });
    expect(jobStates()).toEqual(['succeeded', 'running']); // the dead process never finished its job
    expect(runCli(['dev', 'index', ...ws.args()], ws.env()).code).toBe(0);
    expect(jobStates()).toEqual(['succeeded', 'failed', 'succeeded']);
  });
});
