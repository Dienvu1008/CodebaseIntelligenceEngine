#!/usr/bin/env node
// @ts-check
/**
 * Fixture cache management (P01-13). The cache is disposable: `clean` removes it and `fetch` rebuilds it.
 *
 *   node scripts/bench/fixtures.mjs fetch [id...]   clone or verify reference fixtures at their pinned commits
 *   node scripts/bench/fixtures.mjs verify [id...]  check HEAD == pinned commit and a clean tree
 *   node scripts/bench/fixtures.mjs clean           delete the whole cache
 *   node scripts/bench/fixtures.mjs where           print the cache directory
 *
 * Clones use core.autocrlf=false, so the bytes, and therefore hashes and sizes, are identical on every OS.
 * The CodeForge-v2 reference fixture is cloned FROM the local repository, which is only read, never modified.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { cacheDir, fixturePath, git, loadFixtures, REPO_ROOT } from './lib.mjs';

/** @param {Record<string, string>} f */
function source(f) {
  return f.url ?? path.resolve(REPO_ROOT, f.localSource);
}

/** @param {Record<string, string>} f @returns {string | null} problem, or null if the clone matches its pin */
function verify(f) {
  const dir = fixturePath(f);
  if (!existsSync(path.join(dir, '.git'))) return 'not fetched';
  const head = git(dir, ['rev-parse', 'HEAD']);
  if (head !== f.commit) return `HEAD is ${head}, pinned ${f.commit}`;
  if (git(dir, ['config', 'core.autocrlf']) !== 'false') return 'core.autocrlf is not false';
  if (git(dir, ['status', '--porcelain']) !== '') return 'working tree is dirty';
  return null;
}

/** @param {Record<string, string>} f */
function fetch(f) {
  if (verify(f) === null) {
    console.log(`${f.id}: ok (${f.commit.slice(0, 12)})`);
    return;
  }
  const dir = fixturePath(f);
  rmSync(dir, { recursive: true, force: true }); // disposable: rebuild instead of repairing
  mkdirSync(path.dirname(dir), { recursive: true });
  console.log(`${f.id}: cloning ${source(f)} @ ${f.commit.slice(0, 12)}`);
  // --no-hardlinks: a clone of a local repository shares no files with it, so the cache is fully independent.
  git(path.dirname(dir), ['clone', '--no-checkout', '--no-hardlinks', '--quiet', source(f), dir]);
  git(dir, ['config', 'core.autocrlf', 'false']);
  try {
    git(dir, ['checkout', '--quiet', '--detach', f.commit]);
  } catch {
    git(dir, ['fetch', '--quiet', 'origin', f.commit]); // the pinned commit may not be on a fetched branch
    git(dir, ['checkout', '--quiet', '--detach', f.commit]);
  }
  const problem = verify(f);
  if (problem !== null) throw new Error(`${f.id}: ${problem}`);
  console.log(`${f.id}: ok`);
}

function main() {
  const [command = '', ...ids] = process.argv.slice(2);
  const all = loadFixtures().fixtures.filter((f) => f.mode === 'reference');
  const selected = ids.length === 0 ? all : all.filter((f) => ids.includes(f.id));
  if (command === 'where') return console.log(cacheDir());
  if (command === 'clean') {
    rmSync(cacheDir(), { recursive: true, force: true });
    return console.log(`removed ${cacheDir()}`);
  }
  if (command === 'fetch') return selected.forEach(fetch);
  if (command === 'verify') {
    let failed = false;
    for (const f of selected) {
      const p = verify(f);
      console.log(`${f.id}: ${p ?? 'ok'}`);
      failed ||= p !== null;
    }
    process.exitCode = failed ? 1 : 0;
    return;
  }
  console.error('usage: fixtures.mjs <fetch|verify|clean|where> [id...]');
  process.exitCode = 2;
}

main();
