// AI-004: the LLM is optional. With llm.provider = none (the default), every non-prose capability works;
// the default test suite runs with no LLM. In Phase 01 no code path can reach a model at all.
import { readFileSync, readdirSync } from 'node:fs';
import { DEFAULT_USER_SETTINGS } from '@cie/core';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CLI_TEST_TIMEOUT_MS, cliWorkspace, runCli } from '../../helpers/cli.js';

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS });
import { repoPath } from '../../helpers/repo.js';

const ws = cliWorkspace({ 'src/a.ts': 'export const a = 1;\n', 'pkg/__init__.py': '' });
afterAll(() => ws.dispose());

describe('AI-004: everything works without an LLM', () => {
  it('defaults to no LLM provider', () => {
    expect(DEFAULT_USER_SETTINGS.llmProvider).toBe('none');
  });

  it('runs the default suite LLM-free (no provider configured through the environment)', () => {
    expect(process.env['CIE_LLM_PROVIDER'] ?? 'none').toBe('none');
  });

  it('indexes, reports status and exports with no user configuration at all', () => {
    expect(runCli(['dev', 'index', ...ws.args()], ws.env()).code).toBe(0);
    const status = runCli(['dev', 'status', '--json', ...ws.args()], ws.env());
    expect(status.code).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ revision: 1, freshness: 'current', llmProvider: 'none' });
    expect(runCli(['dev', 'export', ...ws.args()], ws.env()).code).toBe(0);
  });

  it('ships no LLM SDK in any package manifest', () => {
    const LLM_SDK = /^(ollama|openai|@anthropic-ai\/.*|@google\/generative-ai|langchain|@langchain\/.*)$/;
    for (const pkg of readdirSync(repoPath('packages'))) {
      const manifest = JSON.parse(readFileSync(repoPath(`packages/${pkg}/package.json`), 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
        for (const name of Object.keys(manifest[field] ?? {})) expect(name, `${pkg}: ${name}`).not.toMatch(LLM_SDK);
      }
    }
  });
});
