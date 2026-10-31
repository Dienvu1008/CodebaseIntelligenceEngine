import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { repoPath } from './repo.js';

export const CLI = repoPath('packages/runtime/dist/cli/main.js');

/**
 * Per-test timeout for files that spawn the CLI. Since Phase 02 every `dev index` process loads the
 * grammars and the TypeScript compiler (about 1.5 s alone on the reference machine, several times that
 * with 8 parallel workers and on CI), and these tests spawn up to six processes. Other tests keep the 30 s
 * default, so a hang there is still caught quickly. Use: `vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS })`.
 */
export const CLI_TEST_TIMEOUT_MS = 180_000;

export interface CliResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs the built dev CLI in a separate process (the real runtime, as a user or the extension would). */
export function runCli(args: readonly string[], env: Readonly<Record<string, string>> = {}): CliResult {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, CIE_TEST_HOOKS: '', CIE_TEST_KILL_AT: '', ...env },
    timeout: 60_000,
  });
  return { code: r.status, signal: r.signal, stdout: r.stdout, stderr: r.stderr };
}

export interface CliWorkspace {
  readonly root: string;
  readonly workspace: string;
  readonly userConfig: string;
  write(rel: string, content: string | Uint8Array): void;
  remove(rel: string): void;
  /** Arguments selecting this workspace and a given state dir (default: <workspace>/.cie). */
  args(stateDir?: string): string[];
  env(): Record<string, string>;
  dispose(): void;
}

export function cliWorkspace(files: Readonly<Record<string, string>>): CliWorkspace {
  const root = mkdtempSync(path.join(tmpdir(), 'cie-cli-'));
  const workspace = path.join(root, 'ws');
  const userConfig = path.join(root, 'user-config');
  mkdirSync(userConfig, { recursive: true });
  const write = (rel: string, content: string | Uint8Array): void => {
    const abs = path.join(workspace, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  };
  for (const [rel, content] of Object.entries(files)) write(rel, content);
  return {
    root,
    workspace,
    userConfig,
    write,
    remove: (rel) => rmSync(path.join(workspace, ...rel.split('/')), { force: true }),
    args: (stateDir) => ['--workspace', workspace, ...(stateDir === undefined ? [] : ['--state-dir', stateDir])],
    env: () => ({ CIE_CONFIG_DIR: userConfig }),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}
