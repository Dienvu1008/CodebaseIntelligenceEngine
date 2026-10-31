// FF-DEP-*, FF-BND-001/002/005: every dependency-cruiser rule fires on its violation fixture, and the
// real tree has zero violations and zero unresolved imports (ARCHITECTURE_FITNESS §4–5).
import { createRequire } from 'node:module';
import { cruise } from 'dependency-cruiser';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, repoPath } from '../helpers/repo.js';

interface Rule {
  name: string;
}
interface Violation {
  rule: { name: string };
  from: string;
  to: string;
}
interface CruiseResult {
  summary: { violations: Violation[] };
  modules: Array<{ source: string; dependencies: Array<{ module: string; couldNotResolve: boolean }> }>;
}

const require = createRequire(import.meta.url);
const config = require(repoPath('.dependency-cruiser.cjs')) as { forbidden: Rule[]; options: Record<string, unknown> };
const ruleNames = config.forbidden.map((r) => r.name);

async function run(baseDir: string, options: Record<string, unknown>): Promise<CruiseResult> {
  const result = await cruise(['packages'], {
    ...options,
    baseDir,
    validate: true,
    ruleSet: { forbidden: config.forbidden },
  } as never);
  return result.output as unknown as CruiseResult;
}

describe('dependency-cruiser fitness rules', () => {
  it('has a unique, FF-prefixed name for every rule', () => {
    expect(new Set(ruleNames).size).toBe(ruleNames.length);
    for (const name of ruleNames) expect(name).toMatch(/^FF-(DEP|BND)-\d{3}[a-z]?-/);
  });

  it('fires every rule on the deliberate violation fixtures', async () => {
    const output = await run(repoPath('tests/fitness/fixtures/violations'), {
      tsPreCompilationDeps: true,
      doNotFollow: { path: 'node_modules' },
    });
    const fired = new Set(output.summary.violations.map((v) => v.rule.name));
    const silent = ruleNames.filter((name) => !fired.has(name));
    expect(silent, `rules that did not fire: ${silent.join(', ')}`).toEqual([]);
  });

  it('finds no violations and no unresolved imports in the real packages', async () => {
    const output = await run(REPO_ROOT, config.options);
    const violations = output.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`);
    expect(violations).toEqual([]);
    const unresolved = output.modules.flatMap((m) =>
      m.dependencies.filter((d) => d.couldNotResolve).map((d) => `${m.source} -> ${d.module}`),
    );
    expect(unresolved).toEqual([]);
  });
});
