// @ts-check
/**
 * Shared helpers for the benchmark harness (P01-13): fixture resolution, the disposable cache, git facts,
 * environment capture and statistics. Measurement and reproducibility only: no thresholds live here.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Disposable, rebuildable fixture cache outside every workspace. Override with CIE_BENCH_CACHE. */
export function cacheDir() {
  if (process.env.CIE_BENCH_CACHE) return path.resolve(process.env.CIE_BENCH_CACHE);
  const base = process.platform === 'win32' ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')) : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache'));
  return path.join(base, 'cie-bench');
}

/** @returns {{ fixtures: Array<Record<string, string>> }} */
export function loadFixtures() {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'benchmarks', 'fixtures.json'), 'utf8'));
}

/** @param {string} id */
export function fixture(id) {
  const f = loadFixtures().fixtures.find((x) => x.id === id);
  if (!f) throw new Error(`unknown fixture "${id}" (see benchmarks/fixtures.json)`);
  return f;
}

/** Absolute path of a fixture's tree: the cache clone (reference) or the live working tree (dogfood). */
export function fixturePath(f) {
  if (f.mode === 'dogfood') return path.resolve(REPO_ROOT, f.localPath);
  return path.join(cacheDir(), 'fixtures', f.id);
}

/** @param {string} cwd @param {string[]} args */
export const git = (cwd, args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Commit and dirty flag of a git working tree. */
export function gitState(dir) {
  try {
    return { commit: git(dir, ['rev-parse', 'HEAD']), dirty: git(dir, ['status', '--porcelain']) !== '' };
  } catch {
    return { commit: null, dirty: null };
  }
}

const sha256 = (/** @type {string | Buffer} */ s) => createHash('sha256').update(s).digest('hex');

/**
 * Environment capture (BENCHMARK_STRATEGY §2.1). The host name is recorded only as a short hash, so a result
 * identifies the machine without publishing its name.
 */
export function captureEnvironment() {
  const cpus = os.cpus();
  const lock = path.join(REPO_ROOT, 'package-lock.json');
  return {
    os: { platform: process.platform, release: os.release(), arch: process.arch },
    machine: { idHash: sha256(os.hostname()).slice(0, 12), cpuModel: cpus[0]?.model ?? 'unknown', logicalCpus: cpus.length, totalMemMb: Math.round(os.totalmem() / 1048576) },
    load: { loadavg: os.loadavg(), freeMemMb: Math.round(os.freemem() / 1048576) },
    software: {
      node: process.version,
      cie: gitState(REPO_ROOT),
      lockfileSha256: existsSync(lock) ? sha256(readFileSync(lock)) : null,
    },
    notes: {
      disk: 'not captured automatically: record it with --note if relevant',
      osFileCache: 'not controlled: cold runs start a fresh process and an empty state dir, but the OS page cache may be warm',
    },
  };
}

/** @param {number[]} xs */
export function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  const mean = s.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  const q = (/** @type {number} */ p) => s[Math.min(n - 1, Math.ceil(p * n) - 1)] ?? NaN;
  const round = (/** @type {number} */ v) => Math.round(v * 1000) / 1000;
  return { n, median: round(n % 2 ? (s[(n - 1) / 2] ?? NaN) : ((s[n / 2 - 1] ?? 0) + (s[n / 2] ?? 0)) / 2), p95: round(q(0.95)), min: round(s[0] ?? NaN), max: round(s[n - 1] ?? NaN), mean: round(mean), stdev: round(sd), cv: round(mean === 0 ? 0 : sd / mean) };
}
