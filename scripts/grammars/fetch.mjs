#!/usr/bin/env node
// @ts-check
/**
 * Produces the vendored tree-sitter grammar artifacts in packages/adapters/grammars/ (ADR-0010, OQ-09 option A).
 *
 * Each grammar package also ships a native Node binding with an install script (node-gyp-build). CIE uses
 * only the .wasm, so the packages are never installed:
 *   1. the registry's dist metadata (tarball URL, sha512 integrity) is read with `npm view`;
 *   2. `npm pack <pkg>@<exact> --ignore-scripts` downloads the tarball (no lifecycle scripts run);
 *   3. the tarball's sha512 is checked against the registry integrity before anything is extracted;
 *   4. only the .wasm and the LICENSE are extracted with `tar`;
 *   5. the .wasm sha256, byte size and ABI version are recorded in grammars.lock.json, which the adapter
 *      verifies the first time each grammar is loaded in a process;
 *   6. ATTRIBUTION.md is regenerated from the package licenses.
 * Output is deterministic (no timestamps), so --check can prove the committed copy is reproducible.
 *
 *   node scripts/grammars/fetch.mjs --out packages/adapters/grammars     # (re)generate
 *   node scripts/grammars/fetch.mjs --check packages/adapters/grammars   # re-fetch to a temp dir and compare
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const REPO = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));

/** Grammar pins. Changing one follows the upgrade procedure in ADR-0010 §"Upgrade procedure". */
export const GRAMMARS = [
  { language: 'typescript', package: 'tree-sitter-typescript', version: '0.23.2', wasm: 'tree-sitter-typescript.wasm' },
  { language: 'tsx', package: 'tree-sitter-typescript', version: '0.23.2', wasm: 'tree-sitter-tsx.wasm' },
  { language: 'javascript', package: 'tree-sitter-javascript', version: '0.25.0', wasm: 'tree-sitter-javascript.wasm' },
  { language: 'python', package: 'tree-sitter-python', version: '0.25.0', wasm: 'tree-sitter-python.wasm' },
];

export const LOCK_FILE = 'grammars.lock.json';
export const ATTRIBUTION_FILE = 'ATTRIBUTION.md';

/**
 * npm is invoked as `node npm-cli.js`, with no shell: npm.cmd on Windows would need shell=true, which
 * concatenates arguments unescaped (Node DEP0190).
 */
function npmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find((c) => c !== undefined && c.endsWith('.js') && existsSync(c));
  if (!found) throw new Error('cannot locate npm-cli.js next to this Node installation');
  return found;
}
/** @param {string} cmd @param {string[]} args @param {string} cwd */
const exec = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** @param {string[]} args @param {string} cwd */
const npm = (args, cwd) => exec(process.execPath, [npmCli(), ...args], cwd);

/** @param {Uint8Array} bytes @param {'sha256' | 'sha512'} algo */
const digest = (bytes, algo) => createHash(algo).update(bytes).digest(algo === 'sha512' ? 'base64' : 'hex');

/** Text is stored with LF (.gitattributes eol=lf), so it is normalized here too; otherwise --check would flap. */
const lf = (/** @type {string} */ text) => text.replace(/\r\n?/g, '\n');

function fetchPackage(/** @type {string} */ pkg, /** @type {string} */ version, /** @type {string} */ work) {
  /** @type {{ integrity: string, tarball: string }} */
  const dist = JSON.parse(npm(['view', `${pkg}@${version}`, 'dist', '--json'], work));
  if (!dist.integrity?.startsWith('sha512-') || !dist.tarball) throw new Error(`${pkg}@${version}: registry metadata has no sha512 integrity or tarball URL`);
  const name = npm(['pack', `${pkg}@${version}`, '--pack-destination', work, '--ignore-scripts', '--silent'], work).split(/\r?\n/).at(-1) ?? '';
  const file = path.join(work, name);
  const actual = `sha512-${digest(readFileSync(file), 'sha512')}`;
  if (actual !== dist.integrity) throw new Error(`${pkg}@${version}: tarball integrity ${actual} != registry ${dist.integrity}`);
  const dir = path.join(work, `${pkg}-${version}`);
  mkdirSync(dir, { recursive: true });
  // Relative names with cwd=work: Windows bsdtar would read "C:\..." as a remote "host:path" spec.
  exec('tar', ['-xzf', path.basename(file), '-C', path.relative(work, dir)], work);
  const root = path.join(dir, 'package');
  /** @type {{ name: string, version: string, license?: string }} */
  const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.name !== pkg || manifest.version !== version) throw new Error(`${pkg}@${version}: tarball contains ${manifest.name}@${manifest.version}`);
  if (!manifest.license) throw new Error(`${pkg}@${version}: package.json declares no license`);
  const licensePath = ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].map((f) => path.join(root, f)).find((f) => existsSync(f));
  if (!licensePath) throw new Error(`${pkg}@${version}: no LICENSE file in the tarball`);
  return { root, dist, spdx: manifest.license, licenseText: lf(readFileSync(licensePath, 'utf8')) };
}

/** ABI of a grammar as web-tree-sitter sees it; recorded so an upgrade's ABI change shows in review. */
async function abiVersions(/** @type {Map<string, Uint8Array>} */ wasm) {
  const { Parser, Language } = await import('web-tree-sitter');
  await Parser.init();
  /** @type {Map<string, number>} */
  const out = new Map();
  for (const [file, bytes] of wasm) out.set(file, (await Language.load(bytes)).abiVersion);
  return out;
}

function runtimeVersion() {
  /** @type {{ dependencies?: Record<string, string> }} */
  const pkg = JSON.parse(readFileSync(path.join(REPO, 'packages', 'adapters', 'package.json'), 'utf8'));
  const v = pkg.dependencies?.['web-tree-sitter'];
  if (!v || !/^\d+\.\d+\.\d+$/.test(v)) throw new Error('packages/adapters must pin web-tree-sitter to an exact version');
  return v;
}

/**
 * @param {Array<{ package: string, version: string, spdx: string, licenseFile: string, licenseText: string, languages: string[] }>} pkgs
 */
function attribution(pkgs) {
  const lines = [
    '# Third-party grammar artifacts',
    '',
    'Generated by `scripts/grammars/fetch.mjs`; do not edit by hand. Upgrade procedure: ADR-0010.',
    '',
    'This directory vendors only the prebuilt WebAssembly grammars from the npm packages below. The packages',
    'themselves are not installed and their native bindings are not used. Each package\'s license is copied',
    'verbatim next to the artifacts.',
    '',
    '| Package | Version | License | License file | Languages |',
    '|---|---|---|---|---|',
  ];
  for (const p of pkgs) lines.push(`| ${p.package} | ${p.version} | ${p.spdx} | ${p.licenseFile} | ${p.languages.join(', ')} |`);
  for (const p of pkgs) {
    const copyright = p.licenseText.split('\n').filter((l) => /^\s*copyright\b/i.test(l)).map((l) => l.trim());
    lines.push('', `## ${p.package}@${p.version}`, '', `License: ${p.spdx}. ${copyright.join(' ')}`.trimEnd());
  }
  return `${lines.join('\n')}\n`;
}

/** Writes the full artifact set into `out` (which should be empty or a previous output). */
export async function fetchGrammars(/** @type {string} */ out) {
  mkdirSync(out, { recursive: true });
  const work = mkdtempSync(path.join(tmpdir(), 'cie-grammars-'));
  try {
    /** @type {Map<string, ReturnType<typeof fetchPackage>>} */
    const packages = new Map();
    /** @type {Map<string, Uint8Array>} */
    const wasm = new Map();
    for (const g of GRAMMARS) {
      const key = `${g.package}@${g.version}`;
      if (!packages.has(key)) packages.set(key, fetchPackage(g.package, g.version, work));
      const src = path.join(/** @type {ReturnType<typeof fetchPackage>} */ (packages.get(key)).root, g.wasm);
      if (!existsSync(src)) throw new Error(`${key} does not ship ${g.wasm}`);
      wasm.set(g.wasm, readFileSync(src));
    }
    const abi = await abiVersions(wasm);

    const grammars = GRAMMARS.map((g) => {
      const p = /** @type {ReturnType<typeof fetchPackage>} */ (packages.get(`${g.package}@${g.version}`));
      const bytes = /** @type {Uint8Array} */ (wasm.get(g.wasm));
      const licenseFile = `${g.package}.LICENSE`;
      return {
        language: g.language,
        abi: abi.get(g.wasm),
        source: { package: g.package, version: g.version, tarball: p.dist.tarball, integrity: p.dist.integrity },
        artifact: { file: g.wasm, sha256: digest(bytes, 'sha256'), bytes: bytes.length },
        license: { spdx: p.spdx, file: licenseFile, sha256: digest(Buffer.from(p.licenseText, 'utf8'), 'sha256') },
      };
    });

    for (const [file, bytes] of wasm) writeFileSync(path.join(out, file), bytes);
    const pkgs = [...packages].map(([key, p]) => {
      const [name, version] = [key.slice(0, key.lastIndexOf('@')), key.slice(key.lastIndexOf('@') + 1)];
      const licenseFile = `${name}.LICENSE`;
      writeFileSync(path.join(out, licenseFile), p.licenseText);
      const languages = GRAMMARS.filter((g) => g.package === name).map((g) => g.language);
      return { package: name, version, spdx: p.spdx, licenseFile, licenseText: p.licenseText, languages };
    });
    writeFileSync(path.join(out, ATTRIBUTION_FILE), attribution(pkgs));
    const lock = { format: 'cie-grammars/1', runtime: { package: 'web-tree-sitter', version: runtimeVersion() }, grammars };
    writeFileSync(path.join(out, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
    return lock;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Re-fetches into a temp dir and compares every file byte-for-byte with `dir`. Returns the differences. */
export async function checkGrammars(/** @type {string} */ dir) {
  const fresh = mkdtempSync(path.join(tmpdir(), 'cie-grammars-check-'));
  try {
    await fetchGrammars(fresh);
    const names = new Set([...readdirSync(dir), ...readdirSync(fresh)]);
    /** @type {string[]} */
    const problems = [];
    for (const name of [...names].sort()) {
      const a = path.join(dir, name);
      const b = path.join(fresh, name);
      if (!existsSync(a)) problems.push(`${name}: missing from ${dir}`);
      else if (!existsSync(b)) problems.push(`${name}: not produced by fetch.mjs (stray file)`);
      else if (!readFileSync(a).equals(readFileSync(b))) problems.push(`${name}: differs from a fresh fetch`);
    }
    return problems;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
}

// fileURLToPath, not URL.pathname: the repository path may contain spaces (%20) and a Windows drive letter.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, check: { type: 'string' } } });
  if (values.check) {
    const problems = await checkGrammars(path.resolve(values.check));
    for (const p of problems) console.error(`✗ ${p}`);
    if (problems.length > 0) process.exit(1);
    console.log(`✓ ${values.check} matches a fresh fetch byte-for-byte`);
  } else if (values.out) {
    const lock = await fetchGrammars(path.resolve(values.out));
    for (const g of lock.grammars) {
      console.log(`${g.artifact.file}  ${g.artifact.bytes} bytes  abi ${g.abi}  sha256 ${g.artifact.sha256.slice(0, 16)}…  (${g.source.package}@${g.source.version}, ${g.license.spdx})`);
    }
  } else {
    throw new Error('usage: fetch.mjs --out <dir> | --check <dir>');
  }
}
