#!/usr/bin/env node
// @ts-check
/**
 * Governance checks (ADR-0012, NFR-040..043, ARCHITECTURE_FITNESS §2 "governance" job).
 *
 *   node scripts/check-governance.mjs
 *
 * Environment:
 *   CIE_PHASE        overrides governance/phase.yaml current_phase
 *   CIE_GOV_BASE     git ref for the "no invariant removed" check (default: origin/main)
 *   CIE_GOV_STRICT=1 an unavailable base ref is an error instead of a warning (set in CI)
 *
 * The checks are exported as plain functions so tests/fitness/governance.spec.ts can run them
 * against fixture repositories.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import { load as loadYaml } from 'js-yaml';

/** Names of checks implemented here. fitness.yaml may reference them as `governance:<name>`. */
export const GOVERNANCE_CHECKS = Object.freeze([
  'invariant-schema',
  'invariant-ids-unique',
  'invariant-test-presence',
  'invariant-no-removal',
  'invariant-parity',
  'fitness-register',
  'shared-kernel-allowlist',
  'no-utility-folders',
  'manifest-codeforge-scan',
  'phase-checklists',
]);

const INVARIANTS = 'governance/invariants.yaml';
const INVARIANTS_SCHEMA = 'governance/invariants.schema.json';
const FITNESS = 'governance/fitness.yaml';
const ALLOWLIST = 'governance/shared-kernel.allowlist';
const PHASE_FILE = 'governance/phase.yaml';
const INVARIANTS_MD = 'docs/planning/DOMAIN_INVARIANTS.md';
const SHARED_KERNEL_DIR = 'packages/core/src/shared-kernel';
const BASE_INVARIANT_PATHS = [INVARIANTS, 'docs/planning/governance/invariants.yaml'];
const UTILITY_FOLDER_NAMES = new Set(['utils', 'helpers', 'common', 'misc']);
const CHECKLIST_STATUSES = new Set(['pending', 'done', 'deferred']);

/**
 * @typedef {{ errors: string[], warnings: string[] }} Report
 * @typedef {{
 *   repoRoot: string,
 *   phase?: number,
 *   readBase?: (relPath: string) => string | null,
 *   strictBase?: boolean,
 * }} Options
 */

/** @param {string} root @param {string} rel */
const abs = (root, rel) => path.join(root, ...rel.split('/'));
/** @param {string} root @param {string} rel */
const readText = (root, rel) => readFileSync(abs(root, rel), 'utf8');
/** @param {string} root @param {string} rel @returns {any} */
const readYaml = (root, rel) => loadYaml(readText(root, rel));

/** @param {Options} opts @param {Report} report @returns {number} */
function resolvePhase(opts, report) {
  if (typeof opts.phase === 'number') return opts.phase;
  /** @type {any} */
  const doc = readYaml(opts.repoRoot, PHASE_FILE);
  if (!Number.isInteger(doc?.current_phase)) {
    report.errors.push(`${PHASE_FILE}: current_phase must be an integer`);
    return 0;
  }
  return doc.current_phase;
}

/** @param {any} doc @returns {any[]} */
const invariantList = (doc) => (Array.isArray(doc?.invariants) ? doc.invariants : []);

/** @param {string} root @param {any} doc @param {Report} report */
export function checkInvariantSchema(root, doc, report) {
  const schema = JSON.parse(readText(root, INVARIANTS_SCHEMA));
  const ajv = new Ajv({ allErrors: true });
  if (!ajv.validate(schema, doc)) {
    for (const e of ajv.errors ?? []) report.errors.push(`invariant-schema: ${e.instancePath || '/'} ${e.message}`);
  }
}

/** @param {any} doc @param {Report} report */
export function checkInvariantIdsUnique(doc, report) {
  const seen = new Set();
  for (const inv of invariantList(doc)) {
    if (seen.has(inv.id)) report.errors.push(`invariant-ids-unique: duplicate ID ${inv.id}`);
    seen.add(inv.id);
  }
}

/**
 * `phase` is the phase IN PROGRESS (governance/phase.yaml). Invariants of completed phases (< phase) are
 * hard gates (errors). Invariants of the in-progress phase are reported as warnings so progress is visible;
 * they become errors the moment the phase is closed by bumping current_phase (contradiction log C-11).
 * @param {string} root @param {any} doc @param {number} phase @param {Report} report
 */
export function checkInvariantTestPresence(root, doc, phase, report) {
  for (const inv of invariantList(doc)) {
    const gated = inv.status === 'ACTIVE' && (inv.severity === 'CRITICAL' || inv.severity === 'HIGH');
    if (!gated || inv.phase > phase || existsSync(abs(root, inv.test))) continue;
    if (inv.phase < phase) {
      report.errors.push(
        `invariant-test-presence: ${inv.id} (${inv.severity}, phase ${inv.phase}) is required because phase ${inv.phase} is closed, but ${inv.test} is missing`,
      );
    } else {
      report.warnings.push(`invariant-test-presence: ${inv.id} (${inv.severity}) is due at the exit of phase ${phase}; ${inv.test} not written yet`);
    }
  }
}

/** @param {any} doc @param {Options} opts @param {Report} report */
export function checkInvariantNoRemoval(doc, opts, report) {
  const readBase = opts.readBase ?? (() => null);
  let baseText = null;
  for (const p of BASE_INVARIANT_PATHS) {
    baseText = readBase(p);
    if (baseText !== null) break;
  }
  if (baseText === null) {
    const msg = 'invariant-no-removal: base register not available; check skipped';
    (opts.strictBase ? report.errors : report.warnings).push(msg);
    return;
  }
  const current = new Set(invariantList(doc).map((i) => i.id));
  for (const inv of invariantList(loadYaml(baseText))) {
    if (!current.has(inv.id)) {
      report.errors.push(`invariant-no-removal: ${inv.id} was removed; retire it with status DEPRECATED instead`);
    }
  }
}

/** @param {string} root @param {any} doc @param {Report} report */
export function checkInvariantParity(root, doc, report) {
  if (!existsSync(abs(root, INVARIANTS_MD))) {
    report.errors.push(`invariant-parity: ${INVARIANTS_MD} is missing`);
    return;
  }
  /** @type {Map<string, { severity?: string, phase?: number }>} */
  const md = new Map();
  for (const block of readText(root, INVARIANTS_MD).split(/^### /m).slice(1)) {
    const id = /^([A-Z]{2,3}-\d{3}):/.exec(block)?.[1];
    if (!id) continue;
    const severity = /\*\*Severity:\*\* (CRITICAL|HIGH|MEDIUM)/.exec(block)?.[1];
    const phase = /\*\*Phase:\*\* (\d+)/.exec(block)?.[1];
    md.set(id, { severity, phase: phase === undefined ? undefined : Number(phase) });
  }
  const yaml = new Map(invariantList(doc).map((i) => [i.id, i]));
  for (const id of md.keys()) if (!yaml.has(id)) report.errors.push(`invariant-parity: ${id} is in ${INVARIANTS_MD} but not in ${INVARIANTS}`);
  for (const [id, inv] of yaml) {
    const m = md.get(id);
    if (!m) {
      report.errors.push(`invariant-parity: ${id} is in ${INVARIANTS} but not in ${INVARIANTS_MD}`);
    } else if (m.severity !== inv.severity || m.phase !== inv.phase) {
      report.errors.push(
        `invariant-parity: ${id} differs (md severity=${m.severity} phase=${m.phase}; yaml severity=${inv.severity} phase=${inv.phase})`,
      );
    }
  }
}

/** @param {string} root @returns {Set<string>} */
function depcruiseRuleNames(root) {
  const configPath = abs(root, '.dependency-cruiser.cjs');
  if (!existsSync(configPath)) return new Set();
  const require = createRequire(import.meta.url);
  /** @type {any} */
  const config = require(configPath);
  return new Set((config.forbidden ?? []).map((/** @type {any} */ r) => r.name));
}

/** Structural problems of one fitness entry. @param {any} ff @returns {string[]} */
function fitnessEntryProblems(ff) {
  const problems = [];
  if (typeof ff?.id !== 'string' || !/^FF-(DEP|BND|CPX|DAT|PRF)-\d{3}$/.test(ff.id)) problems.push('invalid id');
  if (!['ACTIVE', 'PLANNED'].includes(ff?.status)) problems.push('status must be ACTIVE or PLANNED');
  if (!Number.isInteger(ff?.phase)) problems.push('phase must be an integer');
  if (typeof ff?.blocking !== 'boolean') problems.push('blocking must be a boolean');
  if (!Array.isArray(ff?.enforced_by)) problems.push('enforced_by must be a list');
  else if (ff.status === 'ACTIVE' && ff.enforced_by.length === 0) problems.push('ACTIVE entries need at least one enforced_by reference');
  return problems;
}

/**
 * Problem with one `kind:target` enforcement reference, or null if it resolves.
 * @param {string} root @param {Set<string>} rules @param {string} ref @returns {string | null}
 */
function enforcementRefProblem(root, rules, ref) {
  const [kind = '', ...rest] = ref.split(':');
  const target = rest.join(':');
  switch (kind) {
    case 'depcruise':
      return rules.has(target) ? null : `depcruise rule "${target}" not found`;
    case 'test':
      return existsSync(abs(root, target)) ? null : `test file ${target} not found`;
    case 'governance':
      return GOVERNANCE_CHECKS.includes(target) ? null : `unknown governance check "${target}"`;
    case 'eslint':
      return null;
    default:
      return `unknown reference kind in "${ref}"`;
  }
}

/** @param {string} root @param {Report} report */
export function checkFitnessRegister(root, report) {
  if (!existsSync(abs(root, FITNESS))) {
    report.errors.push(`fitness-register: ${FITNESS} is missing`);
    return;
  }
  /** @type {any} */
  const doc = readYaml(root, FITNESS);
  const entries = Array.isArray(doc?.fitness_functions) ? doc.fitness_functions : [];
  if (entries.length === 0) report.errors.push('fitness-register: no fitness_functions entries');
  const rules = depcruiseRuleNames(root);
  const seen = new Set();
  for (const ff of entries) {
    const problems = [...fitnessEntryProblems(ff), ...activeRefProblems(root, rules, ff)];
    if (seen.has(ff?.id)) problems.push('duplicate id');
    seen.add(ff?.id);
    for (const p of problems) report.errors.push(`fitness-register: ${ff?.id ?? '<missing id>'}: ${p}`);
  }
}

/** Unresolvable enforcement references of an ACTIVE entry. @param {string} root @param {Set<string>} rules @param {any} ff */
function activeRefProblems(root, rules, ff) {
  if (ff?.status !== 'ACTIVE' || !Array.isArray(ff.enforced_by)) return [];
  return ff.enforced_by
    .map((/** @type {unknown} */ ref) => enforcementRefProblem(root, rules, String(ref)))
    .filter((/** @type {string | null} */ p) => p !== null);
}

/** @param {string} dir @param {string} [prefix] @returns {string[]} */
function listFilesRecursive(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) out.push(...listFilesRecursive(full, rel));
    else out.push(rel);
  }
  return out;
}

/** @param {string} root @param {Report} report */
export function checkSharedKernelAllowlist(root, report) {
  const dir = abs(root, SHARED_KERNEL_DIR);
  if (!existsSync(dir)) return;
  const allowed = new Set(
    readText(root, ALLOWLIST)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#')),
  );
  const actual = new Set(listFilesRecursive(dir));
  for (const f of actual) if (!allowed.has(f)) report.errors.push(`shared-kernel-allowlist: ${SHARED_KERNEL_DIR}/${f} is not in ${ALLOWLIST} (adding it requires an ADR)`);
  for (const f of allowed) if (!actual.has(f)) report.errors.push(`shared-kernel-allowlist: ${ALLOWLIST} lists ${f}, which does not exist`);
}

/** @param {string} root @returns {string[]} */
function packageDirs(root) {
  const pkgs = abs(root, 'packages');
  if (!existsSync(pkgs)) return [];
  return readdirSync(pkgs)
    .map((n) => path.join(pkgs, n))
    .filter((p) => statSync(p).isDirectory());
}

/** @param {string} root @param {Report} report */
export function checkNoUtilityFolders(root, report) {
  /** @param {string} dir */
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (!statSync(full).isDirectory()) continue;
      if (UTILITY_FOLDER_NAMES.has(name.toLowerCase())) {
        report.errors.push(`no-utility-folders: ${path.relative(root, full).split(path.sep).join('/')} (DEPENDENCY_RULES C7)`);
      }
      walk(full);
    }
  };
  for (const pkg of packageDirs(root)) {
    const src = path.join(pkg, 'src');
    if (existsSync(src)) walk(src);
  }
}

/** @param {string} root @param {Report} report */
export function checkManifestCodeforgeScan(root, report) {
  const manifests = [path.join(root, 'package.json'), ...packageDirs(root).map((p) => path.join(p, 'package.json'))].filter(existsSync);
  for (const file of manifests) {
    /** @type {any} */
    const pkg = JSON.parse(readFileSync(file, 'utf8'));
    for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
      for (const [name, spec] of Object.entries(pkg[field] ?? {})) {
        if (/codeforge/i.test(name) || /codeforge/i.test(String(spec))) {
          report.errors.push(`manifest-codeforge-scan: ${path.relative(root, file)} ${field} references ${name}@${spec} (FF-DEP-004)`);
        }
      }
    }
  }
}

/**
 * Problems of one checklist item.
 * @param {any} item @param {number} checklistPhase @param {number} currentPhase @returns {string[]}
 */
function checklistItemProblems(item, checklistPhase, currentPhase) {
  const problems = [];
  if (typeof item?.title !== 'string' || typeof item?.check !== 'string') problems.push(`${item?.id} needs title and check`);
  if (!CHECKLIST_STATUSES.has(item?.status)) problems.push(`${item?.id} has invalid status ${item?.status}`);
  if (checklistPhase < currentPhase && item?.status === 'pending') {
    problems.push(`${item.id} is still pending, but the project is in phase ${currentPhase} (an earlier phase cannot exit with pending items)`);
  }
  return problems;
}

/** @param {string} root @param {string} file @param {number} phase @returns {string[]} */
function checklistProblems(root, file, phase) {
  /** @type {any} */
  const doc = readYaml(root, `governance/${file}`);
  const filePhase = Number(file.slice(6, 8));
  const problems = [];
  if (doc?.phase !== filePhase) problems.push('phase field does not match file name');
  const items = Array.isArray(doc?.items) ? doc.items : [];
  if (items.length === 0) problems.push('no items');
  const seen = new Set();
  for (const item of items) {
    if (typeof item?.id !== 'string' || seen.has(item.id)) problems.push(`missing or duplicate item id ${item?.id}`);
    seen.add(item?.id);
    problems.push(...checklistItemProblems(item, filePhase, phase));
  }
  return problems;
}

/** @param {string} root @param {number} phase @param {Report} report */
export function checkPhaseChecklists(root, phase, report) {
  const dir = abs(root, 'governance');
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => /^phase_\d{2}_checklist\.yaml$/.test(f)) : [];
  if (!files.some((f) => Number(f.slice(6, 8)) === phase)) {
    report.errors.push(`phase-checklists: governance/phase_${String(phase).padStart(2, '0')}_checklist.yaml is missing for the current phase`);
  }
  for (const f of files) {
    for (const p of checklistProblems(root, f, phase)) report.errors.push(`phase-checklists: ${f}: ${p}`);
  }
}

/** @param {Options} opts @returns {Report} */
export function runChecks(opts) {
  /** @type {Report} */
  const report = { errors: [], warnings: [] };
  const root = opts.repoRoot;
  const phase = resolvePhase(opts, report);
  /** @type {any} */
  let doc;
  try {
    doc = readYaml(root, INVARIANTS);
  } catch (e) {
    report.errors.push(`invariant-schema: cannot parse ${INVARIANTS}: ${e instanceof Error ? e.message : String(e)}`);
    return report;
  }
  checkInvariantSchema(root, doc, report);
  checkInvariantIdsUnique(doc, report);
  checkInvariantTestPresence(root, doc, phase, report);
  checkInvariantNoRemoval(doc, opts, report);
  checkInvariantParity(root, doc, report);
  checkFitnessRegister(root, report);
  checkSharedKernelAllowlist(root, report);
  checkNoUtilityFolders(root, report);
  checkManifestCodeforgeScan(root, report);
  checkPhaseChecklists(root, phase, report);
  return report;
}

/** @param {string} repoRoot @param {string} ref @returns {(rel: string) => string | null} */
export function gitBaseReader(repoRoot, ref) {
  return (rel) => {
    try {
      return execFileSync('git', ['show', `${ref}:${rel}`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
}

function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const envPhase = process.env.CIE_PHASE;
  const baseRef = process.env.CIE_GOV_BASE ?? 'origin/main';
  /** @type {Options} */
  const opts = {
    repoRoot,
    readBase: gitBaseReader(repoRoot, baseRef),
    strictBase: process.env.CIE_GOV_STRICT === '1',
  };
  if (envPhase !== undefined) opts.phase = Number(envPhase);
  const report = runChecks(opts);
  for (const w of report.warnings) console.warn(`warning: ${w}`);
  for (const e of report.errors) console.error(`error: ${e}`);
  if (report.errors.length > 0) {
    console.error(`governance: ${report.errors.length} error(s)`);
    process.exit(1);
  }
  console.log(`governance: OK (${GOVERNANCE_CHECKS.length} checks, base ${baseRef})`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
