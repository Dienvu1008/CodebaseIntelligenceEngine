// P02-07 golden: PythonImportResolver output for fixtures/py-basic and fixtures/py-src-layout matches the
// committed, hand-reviewed golden files. Every edge must be heuristic or unknown (L2 producer, SY-006).
// To regenerate deliberately: CIE_UPDATE_GOLDEN=1 npx vitest run tests/golden/python-imports.spec.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PythonImportResolver } from '@cie/adapters';
import { importEdgeViolations } from '@cie/core';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../helpers/repo.js';
import { edgeSummary, resolveFixture } from '../helpers/workspace-fixture.js';

const resolver = (() => {
  const r = PythonImportResolver.create();
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
})();

/** Fixture files as a path → text record, `/`-separated, sorted. */
function readTree(root: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of readdirSync(path.join(root, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const r = rel === '' ? entry.name : `${rel}/${entry.name}`;
    if (entry.isDirectory()) Object.assign(out, readTree(root, r));
    else out[r] = readFileSync(path.join(root, r), 'utf8');
  }
  return out;
}

for (const fixture of ['py-basic', 'py-src-layout']) {
  describe(`python imports golden: ${fixture}`, () => {
    it('matches the committed golden file', async () => {
      const { resolution } = await resolveFixture(readTree(repoPath(`fixtures/${fixture}`)), resolver);
      expect(resolution.edges.flatMap(importEdgeViolations)).toEqual([]);
      expect(resolution.edges.every((e) => e.precision !== 'exact')).toBe(true);
      const actual = `${JSON.stringify({ projects: resolution.projects, edges: edgeSummary(resolution.edges), diagnostics: resolution.diagnostics }, null, 2)}\n`;
      const golden = repoPath(`fixtures/${fixture}.imports.json`);
      if (process.env['CIE_UPDATE_GOLDEN'] === '1') writeFileSync(golden, actual);
      expect(actual).toBe(readFileSync(golden, 'utf8'));
    });
  });
}
