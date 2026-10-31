#!/usr/bin/env node
// @ts-check
/**
 * Benchmark runner (P01-13, BENCHMARK_STRATEGY §2–§4). It measures and records; it never judges. There are
 * no thresholds until baselines exist (NFR-066).
 *
 *   node scripts/bench/run.mjs --fixture <id> [--scenarios B-01,B-02,B-10,B-11] [--reps 5] [--note "..."] [--out <file>]
 *
 * Scenarios (Phase 01 subset):
 *   B-01  full index, cold: new process, empty state dir (OS page cache NOT controlled; labeled as such)
 *   B-02  full index, warm: one discarded warm-up run, then measured runs, each with an emptied state dir
 *   B-10  crash recovery: SIGKILL at "staged", then the measured run recovers and publishes
 *   B-11  corrupt index.db: overwritten with garbage, then the measured run quarantines and rebuilds
 * Every run uses a state dir in the cache, never inside the fixture, so fixtures stay pristine.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cacheDir, captureEnvironment, cieState, fixture, fixturePath, gitState, REPO_ROOT, stats } from './lib.mjs';

const CLI = path.join(REPO_ROOT, 'packages', 'runtime', 'dist', 'cli', 'main.js');
const RESULTS_FORMAT = 'cie-bench-result/1';

/** @param {string} workspace @param {string} stateDir @param {Record<string, string>} [env] */
function index(workspace, stateDir, env = {}) {
  const t0 = performance.now();
  const r = spawnSync(process.execPath, [CLI, 'dev', 'index', '--json', '--timings', '--workspace', workspace, '--state-dir', stateDir], {
    encoding: 'utf8',
    env: { ...process.env, CIE_CONFIG_DIR: path.join(cacheDir(), 'user-config'), ...env },
    maxBuffer: 256 * 1024 * 1024,
  });
  const wallMs = Math.round((performance.now() - t0) * 1000) / 1000;
  return { status: r.status, signal: r.signal, wallMs, out: r.status === 0 ? JSON.parse(r.stdout) : null, stderr: r.stderr };
}

/** Sizes of the CIE stores after a run (BENCHMARK_STRATEGY §2.3). */
function storeSizes(stateDir) {
  /** @type {Record<string, number>} */
  const sizes = {};
  for (const name of readdirSync(stateDir)) if (/\.db(-wal)?$/.test(name)) sizes[name] = statSync(path.join(stateDir, name)).size;
  return sizes;
}

/** One measured sample from a successful run. */
function sample(run, stateDir) {
  if (run.status !== 0 || run.out === null) throw new Error(`index failed (status ${run.status}): ${run.stderr}`);
  const o = run.out;
  return {
    wallMs: run.wallMs,
    inProcessMs: o.timings.totalMs,
    stagesMs: o.timings.stagesMs,
    maxRssKb: o.timings.maxRssKb,
    work: { files: o.files, structure: o.structure, ignored: o.enumeration.ignored, unrepresentable: o.enumeration.unrepresentable.length },
    manifestHash: o.manifestHash,
    storeBytes: storeSizes(stateDir),
  };
}

const scenarios = {
  'B-01': (/** @type {string} */ ws, /** @type {string} */ sd) => {
    rmSync(sd, { recursive: true, force: true });
    return sample(index(ws, sd), sd);
  },
  'B-02': (/** @type {string} */ ws, /** @type {string} */ sd) => {
    rmSync(sd, { recursive: true, force: true });
    return sample(index(ws, sd), sd);
  },
  'B-10': (/** @type {string} */ ws, /** @type {string} */ sd) => {
    rmSync(sd, { recursive: true, force: true });
    if (index(ws, sd).status !== 0) throw new Error('B-10 setup failed');
    const killed = index(ws, sd, { CIE_TEST_HOOKS: '1', CIE_TEST_KILL_AT: 'staged' });
    if (killed.status === 0) throw new Error('B-10: the crash was not injected');
    const s = sample(index(ws, sd), sd);
    if (s.work.files.inserted !== 0 || s.work.files.closed !== 0) throw new Error('B-10: the recovered revision differs from the pre-crash tree');
    return s;
  },
  'B-11': (/** @type {string} */ ws, /** @type {string} */ sd) => {
    rmSync(sd, { recursive: true, force: true });
    if (index(ws, sd).status !== 0) throw new Error('B-11 setup failed');
    writeFileSync(path.join(sd, 'index.db'), Buffer.alloc(64 * 1024, 0x5a));
    return sample(index(ws, sd), sd);
  },
};

/** Runs one scenario `reps` times and summarizes it. */
function runScenario(/** @type {string} */ id, /** @type {string} */ ws, /** @type {string} */ stateDir, /** @type {number} */ reps) {
  const run = scenarios[/** @type {keyof typeof scenarios} */ (id)];
  if (!run) throw new Error(`unknown scenario ${id}`);
  if (id === 'B-02') run(ws, stateDir); // discarded warm-up
  const samples = [];
  for (let i = 0; i < reps; i++) samples.push(run(ws, stateDir));
  return {
    samples,
    summary: {
      wallMs: stats(samples.map((s) => s.wallMs)),
      inProcessMs: stats(samples.map((s) => s.inProcessMs)),
      maxRssKb: stats(samples.map((s) => s.maxRssKb)),
    },
    deterministic: new Set(samples.map((s) => s.manifestHash)).size === 1,
  };
}

/** Tier classification counts files with status "indexed" after ignore rules (BENCHMARK_STRATEGY §3). */
function exportedFiles(/** @type {string} */ ws, /** @type {string} */ stateDir) {
  const exported = spawnSync(process.execPath, [CLI, 'dev', 'export', '--workspace', ws, '--state-dir', stateDir], {
    encoding: 'utf8',
    env: { ...process.env, CIE_CONFIG_DIR: path.join(cacheDir(), 'user-config') },
    maxBuffer: 256 * 1024 * 1024,
  });
  return exported.status === 0 ? /** @type {Array<{status: string}>} */ (JSON.parse(exported.stdout).files) : null;
}

/** A reference fixture must be exactly at its pin with a clean tree, or its numbers are not comparable. */
function assertPinned(/** @type {Record<string, string>} */ f, /** @type {{commit: string|null, dirty: boolean|null}} */ tree) {
  if (f.mode === 'reference' && (tree.commit !== f.commit || tree.dirty !== false)) {
    throw new Error(`${f.id}: the cache clone does not match its pin (${JSON.stringify(tree)}); run scripts/bench/fixtures.mjs fetch ${f.id}`);
  }
}

function main() {
  const { values } = parseArgs({
    options: { fixture: { type: 'string' }, scenarios: { type: 'string' }, reps: { type: 'string' }, note: { type: 'string' }, out: { type: 'string' } },
  });
  if (!values.fixture) throw new Error('--fixture is required (see benchmarks/fixtures.json)');
  const f = fixture(values.fixture);
  const ws = fixturePath(f);
  const tree = gitState(ws);
  assertPinned(f, tree);
  if (cieState().dirty) console.warn('warning: the CIE checkout is dirty; this result must not be used as a baseline');
  const reps = Number(values.reps ?? 5);
  const stateDir = path.join(cacheDir(), 'state', `${f.id}-${process.pid}`);
  const env = captureEnvironment();
  /** @type {Record<string, ReturnType<typeof runScenario>>} */
  const results = {};
  for (const id of (values.scenarios ?? 'B-01,B-02,B-10,B-11').split(',')) {
    const r = runScenario(id, ws, stateDir, reps);
    results[id] = r;
    console.log(`${f.id} ${id}: median ${r.summary.wallMs.median} ms (cv ${r.summary.wallMs.cv}), deterministic=${r.deterministic}`);
  }
  const files = exportedFiles(ws, stateDir);
  rmSync(stateDir, { recursive: true, force: true });
  const after = gitState(ws);
  if (f.mode === 'reference' && after.statusHash !== tree.statusHash) throw new Error(`${f.id}: the pinned clone changed during the run`);
  writeResult(f, tree, after, env, values, reps, results, files);
}

function writeResult(f, tree, after, env, values, reps, results, files) {
  const doc = {
    format: RESULTS_FORMAT,
    createdAt: new Date().toISOString(),
    fixture: {
      id: f.id,
      mode: f.mode,
      reproducible: f.mode === 'reference',
      pinnedCommit: f.commit ?? null,
      actualCommit: tree.commit,
      dirty: tree.dirty,
      // false means the tree was modified while it was being measured (live dogfood trees only).
      stableDuringRun: tree.statusHash !== null && tree.statusHash === after.statusHash,
      statusBefore: tree.statusHash,
      statusAfter: after.statusHash,
      tier: f.tier,
      tierBasis: f.tierBasis,
      manifestEntries: files?.length ?? null,
      indexedFiles: files?.filter((/** @type {{status: string}} */ e) => e.status === 'indexed').length ?? null,
    },
    environment: env,
    note: values.note ?? null,
    repetitions: reps,
    scenarios: results,
  };
  const out = values.out ?? path.join(REPO_ROOT, 'benchmarks', 'results', `${doc.createdAt.slice(0, 10)}-${(env.software.cie.commit ?? 'nocommit').slice(0, 8)}-${env.machine.idHash}-${f.id}.json`);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(doc, null, 2)}\n`);
  console.log(`wrote ${path.relative(REPO_ROOT, out)}`);
}

main();
