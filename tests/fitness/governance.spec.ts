// FF-DAT-007 and the check-governance acceptance criteria (IMPLEMENTATION_ROADMAP Phase 00): the script
// passes on the real repository, and it fails on an invalid register, a missing CRITICAL invariant test,
// a removed ID, a parity mismatch and the other governed conditions.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { dump, load } from 'js-yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runChecks, type Options } from '../../scripts/check-governance.mjs';
import { REPO_ROOT, repoPath } from '../helpers/repo.js';

interface Invariant {
  id: string;
  severity: string;
  phase: number;
  test: string;
  status: string;
}
interface Register {
  version: string;
  invariants: Invariant[];
}

const realRegisterText = readFileSync(repoPath('governance/invariants.yaml'), 'utf8');
const tempDirs: string[] = [];

/** Copies the governed files into a throwaway repository so each test can mutate them. */
function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cie-gov-'));
  tempDirs.push(dir);
  for (const rel of [
    'governance',
    'docs/planning/DOMAIN_INVARIANTS.md',
    '.dependency-cruiser.cjs',
    'package.json',
    'packages/core/src/shared-kernel',
    'tests/fitness',
  ]) {
    cpSync(repoPath(rel), path.join(dir, ...rel.split('/')), { recursive: true });
  }
  return dir;
}

const options = (repoRoot: string, extra: Partial<Options> = {}): Options => ({
  repoRoot,
  phase: 0,
  readBase: () => realRegisterText,
  strictBase: true,
  ...extra,
});

function editRegister(dir: string, edit: (reg: Register) => void): void {
  const file = path.join(dir, 'governance', 'invariants.yaml');
  const reg = load(readFileSync(file, 'utf8')) as Register;
  edit(reg);
  writeFileSync(file, dump(reg));
}

const find = (reg: Register, id: string): Invariant => {
  const inv = reg.invariants.find((i) => i.id === id);
  if (!inv) throw new Error(`fixture is missing ${id}`);
  return inv;
};

afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('check-governance on the real repository', () => {
  it('passes with no errors', () => {
    const report = runChecks(options(REPO_ROOT));
    expect(report.errors).toEqual([]);
  });
});

describe('check-governance failure modes', () => {
  it('passes on an unmodified copy (fixture sanity)', () => {
    expect(runChecks(options(makeRepo())).errors).toEqual([]);
  });

  it('rejects a register that violates the schema', () => {
    const dir = makeRepo();
    editRegister(dir, (reg) => {
      find(reg, 'WS-004').severity = 'SEVERE';
    });
    expect(runChecks(options(dir)).errors.some((e) => e.startsWith('invariant-schema:'))).toBe(true);
  });

  it('rejects an unparseable register', () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, 'governance', 'invariants.yaml'), 'invariants: [unclosed');
    expect(runChecks(options(dir)).errors.some((e) => e.includes('cannot parse'))).toBe(true);
  });

  it('rejects a CRITICAL invariant that is due but has no test file', () => {
    const dir = makeRepo();
    editRegister(dir, (reg) => {
      find(reg, 'WS-001').phase = 0;
    });
    const errors = runChecks(options(dir)).errors;
    expect(errors.some((e) => e.startsWith('invariant-test-presence: WS-001'))).toBe(true);
  });

  it('does not require tests for invariants of later phases', () => {
    const dir = makeRepo();
    expect(runChecks(options(dir, { phase: 0 })).errors.filter((e) => e.startsWith('invariant-test-presence'))).toEqual([]);
    const phase1 = runChecks(options(dir, { phase: 1 })).errors.filter((e) => e.startsWith('invariant-test-presence'));
    expect(phase1.length).toBeGreaterThan(0);
  });

  it('rejects a removed invariant ID', () => {
    const dir = makeRepo();
    editRegister(dir, (reg) => {
      reg.invariants = reg.invariants.filter((i) => i.id !== 'WS-004');
    });
    expect(runChecks(options(dir)).errors).toContain(
      'invariant-no-removal: WS-004 was removed; retire it with status DEPRECATED instead',
    );
  });

  it('treats a missing base as an error in strict mode and a warning otherwise', () => {
    const dir = makeRepo();
    const strict = runChecks(options(dir, { readBase: () => null, strictBase: true }));
    expect(strict.errors.some((e) => e.startsWith('invariant-no-removal'))).toBe(true);
    const lenient = runChecks(options(dir, { readBase: () => null, strictBase: false }));
    expect(lenient.errors).toEqual([]);
    expect(lenient.warnings.some((w) => w.startsWith('invariant-no-removal'))).toBe(true);
  });

  it('rejects a severity mismatch between DOMAIN_INVARIANTS.md and the register', () => {
    const dir = makeRepo();
    editRegister(dir, (reg) => {
      find(reg, 'WS-004').severity = 'MEDIUM';
    });
    expect(runChecks(options(dir)).errors.some((e) => e.startsWith('invariant-parity: WS-004 differs'))).toBe(true);
  });

  it('rejects an active fitness function that references a missing depcruise rule', () => {
    const dir = makeRepo();
    const file = path.join(dir, 'governance', 'fitness.yaml');
    writeFileSync(file, readFileSync(file, 'utf8').replace('depcruise:FF-DEP-001-no-circular', 'depcruise:FF-DEP-001-renamed'));
    expect(runChecks(options(dir)).errors.some((e) => e.includes('depcruise rule "FF-DEP-001-renamed" not found'))).toBe(true);
  });

  it('rejects a shared-kernel file that is not allow-listed', () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, 'packages', 'core', 'src', 'shared-kernel', 'string-utils.ts'), 'export {};\n');
    expect(runChecks(options(dir)).errors.some((e) => e.startsWith('shared-kernel-allowlist:'))).toBe(true);
  });

  it('rejects a utils folder in a package', () => {
    const dir = makeRepo();
    mkdirSync(path.join(dir, 'packages', 'core', 'src', 'workspace', 'utils'), { recursive: true });
    expect(runChecks(options(dir)).errors.some((e) => e.startsWith('no-utility-folders:'))).toBe(true);
  });

  it('rejects a CodeForge dependency in a manifest', () => {
    const dir = makeRepo();
    const file = path.join(dir, 'package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { devDependencies: Record<string, string> };
    pkg.devDependencies['@codeforge/agent-core'] = '0.0.0';
    writeFileSync(file, JSON.stringify(pkg));
    expect(runChecks(options(dir)).errors.some((e) => e.startsWith('manifest-codeforge-scan:'))).toBe(true);
  });

  it('rejects pending items of an earlier phase and a missing checklist for the current phase', () => {
    const dir = makeRepo();
    const errors = runChecks(options(dir, { phase: 1 })).errors;
    expect(errors.some((e) => e.includes('phase_00_checklist.yaml') && e.includes('still pending'))).toBe(true);
    expect(errors.some((e) => e.includes('phase_01_checklist.yaml is missing'))).toBe(true);
  });
});
