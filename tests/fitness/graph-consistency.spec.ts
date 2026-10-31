// FF-DAT-003: graph consistency on every golden fixture. Each fixture is indexed twice through the real CLI
// (two published revisions, the second unchanged), then the database is checked independently of the store
// code, at every published seq:
//  - KG-001: no visible edge has an endpoint that is not visible at the same seq (interval-aware);
//  - SY-002: no node id and no edge identity is visible twice;
//  - WS-001: every code node's file and every edge's evidence file is visible at that seq;
//  - SY-005: every visible code node and edge records producer and fidelity;
//  - FF-DAT-001: PRAGMA foreign_key_check is empty.
// Publishing already ran the RevisionValidator; these queries are the second, independent layer.
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CLI_TEST_TIMEOUT_MS, runCli } from '../helpers/cli.js';
import { GOLDEN_FIXTURES } from '../helpers/golden.js';
import { repoPath } from '../helpers/repo.js';

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS });

const scratch = mkdtempSync(path.join(tmpdir(), 'cie-ffdat003-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

// Written out here on purpose instead of importing visibleAt: an independent restatement of ADR-0015.
const vis = (a: string) => `${a}.valid_from_seq <= r.seq and (${a}.valid_to_seq is null or ${a}.valid_to_seq > r.seq)`;
const PUBLISHED = "select seq from index_revision where status in ('published','superseded')";

const CHECKS: Record<string, string> = {
  'KG-001 dangling endpoint': `
    select r.seq, e.id from (${PUBLISHED}) r join edge e on ${vis('e')}
    where not exists (select 1 from node n where n.node_key = e.from_key and ${vis('n')})
       or not exists (select 1 from node n where n.node_key = e.to_key and ${vis('n')})`,
  'SY-002 duplicate node': `
    select r.seq, n.node_key from (${PUBLISHED}) r join node n on ${vis('n')} group by r.seq, n.node_key having count(*) > 1`,
  'SY-002 duplicate edge': `
    select r.seq, e.type from (${PUBLISHED}) r join edge e on ${vis('e')} group by r.seq, e.type, e.from_key, e.to_key, e.site_key having count(*) > 1`,
  'WS-001 node file not visible': `
    select r.seq, n.id from (${PUBLISHED}) r join node n on ${vis('n')}
    where n.file_key is not null and not exists (select 1 from file f where f.file_key = n.file_key and ${vis('f')})`,
  'WS-001 evidence file not visible': `
    select r.seq, e.id from (${PUBLISHED}) r join edge e on ${vis('e')}
    where e.ev_file_key is not null and not exists (select 1 from file f where f.file_key = e.ev_file_key and ${vis('f')})`,
  'SY-005 unattributed node': `
    select r.seq, n.id from (${PUBLISHED}) r join node n on ${vis('n')}
    where n.kind in ('module','symbol','external','unresolved') and (n.producer is null or n.fidelity is null)`,
};

describe('FF-DAT-003: graph consistency on golden fixtures', () => {
  for (const fixture of GOLDEN_FIXTURES) {
    it(fixture, () => {
      const args = ['--workspace', repoPath(`fixtures/${fixture}`), '--state-dir', path.join(scratch, fixture)];
      const env = { CIE_CONFIG_DIR: path.join(scratch, 'user-config') };
      for (let i = 0; i < 2; i++) {
        const r = runCli(['dev', 'index', ...args], env);
        expect(r.code, r.stderr).toBe(0);
      }
      const db = new Database(path.join(scratch, fixture, 'index.db'), { readonly: true });
      try {
        expect(db.prepare(PUBLISHED).all()).toHaveLength(2);
        const graphSize = db.prepare(`select (select count(*) from node where kind = 'symbol') as symbols, (select count(*) from edge) as edges`).get() as { symbols: number; edges: number };
        expect(graphSize.edges, 'the fixture must exercise the graph').toBeGreaterThan(0);
        for (const [name, sql] of Object.entries(CHECKS)) expect(db.prepare(sql).all(), name).toEqual([]);
        expect(db.pragma('foreign_key_check')).toEqual([]);
      } finally {
        db.close();
      }
    });
  }

  it('the checks detect a broken graph (self-test on a damaged copy)', () => {
    const fixture = GOLDEN_FIXTURES[0];
    // The CLI closed the database (checkpointed), so the main file holds everything. Damage a copy, not the original.
    const copy = path.join(scratch, 'damaged.db');
    copyFileSync(path.join(scratch, fixture, 'index.db'), copy);
    const db = new Database(copy);
    try {
      // Close one symbol at seq 2 while the edges pointing at it stay open: a dangling edge at seq 2.
      const victim = db.prepare("select n.id from node n where n.kind = 'symbol' and exists (select 1 from edge e where e.to_key = n.node_key) limit 1").pluck().get() as number;
      db.prepare('update node set valid_to_seq = 2 where id = ?').run(victim);
      const found = db.prepare(CHECKS['KG-001 dangling endpoint'] as string).all() as Array<{ seq: number }>;
      expect(found.length).toBeGreaterThan(0);
      expect(new Set(found.map((f) => f.seq))).toEqual(new Set([2]));
    } finally {
      db.close();
    }
  });
});
