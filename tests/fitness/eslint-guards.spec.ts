// The ESLint duplicates of the critical import bans (FF-DEP-002/003/004/005) and FF-CPX-005 actually fire.
// Code is linted as virtual files, so nothing is written to the source tree.
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/repo.js';

const eslint = new ESLint({ cwd: REPO_ROOT });

async function ruleIds(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((m) => m.ruleId ?? 'fatal');
}

const CORE_FILE = 'packages/core/src/workspace/domain/probe.ts';
const RUNTIME_FILE = 'packages/runtime/src/probe.ts';

describe('ESLint architecture guards', () => {
  it.each([
    ["import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n", 'Node built-in (node: scheme)'],
    ["import { readFileSync } from 'fs';\nexport const x = readFileSync;\n", 'Node built-in (bare name)'],
    ["import Database from 'better-sqlite3';\nexport const x = Database;\n", 'storage driver'],
  ])('rejects %s in core (%s)', async (code) => {
    expect(await ruleIds(code, CORE_FILE)).toContain('no-restricted-imports');
  });

  it.each([
    ["import * as vscode from 'vscode';\nexport const x = vscode;\n"],
    ["import { TaskGraph } from '@codeforge/agent-core';\nexport const x = TaskGraph;\n"],
    ["import React from 'react';\nexport const x = React;\n"],
  ])('rejects %s outside the extension', async (code) => {
    expect(await ruleIds(code, RUNTIME_FILE)).toContain('no-restricted-imports');
  });

  it('allows Node built-ins in the runtime', async () => {
    expect(await ruleIds("import { readFileSync } from 'node:fs';\nexport const x = readFileSync;\n", RUNTIME_FILE)).toEqual([]);
  });

  it('rejects any and non-null assertions in core (FF-CPX-005)', async () => {
    const ids = await ruleIds('export const f = (x: any): number => (x as { n?: number }).n!;\n', CORE_FILE);
    expect(ids).toContain('@typescript-eslint/no-explicit-any');
    expect(ids).toContain('@typescript-eslint/no-non-null-assertion');
  });
});
