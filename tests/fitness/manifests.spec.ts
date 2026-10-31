// P00-01/02, FF-DEP-005, FF-DEP-006, NFR-054, ADR-0013: package manifest rules.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { repoPath } from '../helpers/repo.js';

interface Manifest {
  name: string;
  private?: boolean;
  license?: string;
  engines?: Record<string, string>;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const readJson = (rel: string): Manifest => JSON.parse(readFileSync(repoPath(rel), 'utf8')) as Manifest;
const packageNames = readdirSync(repoPath('packages')).filter((n) => existsSync(repoPath(`packages/${n}/package.json`)));
const manifests: Array<[string, Manifest]> = [
  ['package.json', readJson('package.json')],
  ...packageNames.map((n): [string, Manifest] => [`packages/${n}/package.json`, readJson(`packages/${n}/package.json`)]),
];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;
const UI_BUILD_DEPS = /^(react|react-dom|vite|esbuild|markdown-it|dompurify|@vitejs\/.*)$/;

describe('root manifest', () => {
  const root = readJson('package.json');
  it('targets the supported Node LTS range (ADR-0004)', () => {
    expect(root.engines?.['node']).toBe('>=24 <27');
  });
  it('lists exactly the existing packages as workspaces', () => {
    expect([...(root.workspaces ?? [])].sort()).toEqual(packageNames.map((n) => `packages/${n}`).sort());
  });
  it('pins dependencies exactly and enforces engines (.npmrc)', () => {
    const npmrc = readFileSync(repoPath('.npmrc'), 'utf8');
    expect(npmrc).toMatch(/^save-exact=true$/m);
    expect(npmrc).toMatch(/^engine-strict=true$/m);
    expect(existsSync(repoPath('package-lock.json'))).toBe(true);
  });
});

describe.each(manifests)('%s', (_file, manifest) => {
  it('is private and UNLICENSED until ADR-0013 is decided', () => {
    expect(manifest.private).toBe(true);
    expect(manifest.license).toBe('UNLICENSED');
  });
  it('uses exact versions only (NFR-054)', () => {
    for (const field of DEP_FIELDS) {
      for (const [name, spec] of Object.entries(manifest[field] ?? {})) {
        expect(spec, `${name} in ${field}`).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/);
      }
    }
  });
  it('declares no UI or build dependency outside the extension (FF-DEP-005)', () => {
    if (manifest.name === 'cie-vscode') return;
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(manifest[field] ?? {})) expect(name).not.toMatch(UI_BUILD_DEPS);
    }
  });
});

describe('dependency-free packages', () => {
  it.each(['protocol', 'core'])('@cie/%s has no dependencies of any kind (FF-DEP-002, FF-DEP-006)', (pkg) => {
    const manifest = readJson(`packages/${pkg}/package.json`);
    for (const field of DEP_FIELDS) expect(manifest[field] ?? {}).toEqual({});
  });
});
