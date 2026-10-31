// A-06 / T3 (SECURITY_AND_RELIABILITY): a repository cannot make CIE execute code through its TypeScript
// configuration, neither on the resolution path (Phase 02) nor when lang-ts builds a Program and TypeChecker per
// project (Phase 03, P03-01). The workspace below declares compiler/tsserver plugins and an `extends` that point at
// packages whose entry points write a marker file when loaded, both as an installed package
// (node_modules, never part of the snapshot) and as a workspace package (part of the snapshot).
// Resolution must succeed without loading any of them. A positive control proves the canary fires when the
// plugin is really required, so a passing test is not an artifact of a broken canary.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GuardedFileSystem, LangTsResolver, NodeHasher, TreeSitterExtractor } from '@cie/adapters';
import type { CanonicalPath, FileExtraction, LanguageId, ManifestEntry } from '@cie/core';
import { afterAll, describe, expect, it } from 'vitest';

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

const CANARY = (marker: string) =>
  `require('fs').writeFileSync(require('path').join(__dirname, ${JSON.stringify(path.join('..', '..'))}, ${JSON.stringify(marker)}), 'loaded');\nmodule.exports = () => ({ create: (info) => info.languageService });\n`;

function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

const SNAPSHOT: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'victim', private: true, devDependencies: { 'evil-plugin': '1', 'evil-workspace-plugin': '1' } }),
  'tsconfig.json': JSON.stringify({
    extends: 'evil-workspace-plugin/tsconfig.json',
    compilerOptions: { plugins: [{ name: 'evil-plugin' }, { name: 'evil-workspace-plugin' }, { transform: 'evil-plugin' }] },
    include: ['src'],
  }),
  'src/a.ts': "import { b } from './b';\nimport 'evil-plugin';\nimport 'evil-workspace-plugin';\n",
  'src/b.ts': 'export const b = 1;\n',
  // A workspace package: inside the snapshot, so its files are visible to resolution.
  'tools/evil/package.json': JSON.stringify({ name: 'evil-workspace-plugin', main: 'index.js' }),
  'tools/evil/index.js': CANARY('PWNED-workspace'),
  'tools/evil/tsconfig.json': JSON.stringify({ compilerOptions: { plugins: [{ name: 'evil-plugin' }] } }),
};
const INSTALLED: Record<string, string> = {
  'node_modules/evil-plugin/package.json': JSON.stringify({ name: 'evil-plugin', main: 'index.js' }),
  'node_modules/evil-plugin/index.js': CANARY('PWNED-installed'),
};

async function extractAll(root: string): Promise<{ manifest: ManifestEntry[]; extractions: FileExtraction[] }> {
  const hasher = new NodeHasher();
  const x = await TreeSitterExtractor.create();
  if (!x.ok) throw new Error(x.error.message);
  const manifest: ManifestEntry[] = [];
  const extractions: FileExtraction[] = [];
  for (const rel of Object.keys(SNAPSHOT).sort()) {
    const bytes = new TextEncoder().encode(SNAPSHOT[rel]);
    const language = rel.endsWith('.ts') ? 'ts' : rel.endsWith('.js') ? 'js' : null;
    manifest.push({ path: rel as CanonicalPath, status: 'indexed', hash: hasher.sha256(bytes), size: bytes.length, language });
    if (language === null) continue;
    const e = await x.value.extractFile({ path: rel as CanonicalPath, language: language as LanguageId, content: bytes, contentHash: hasher.sha256(bytes) }, new AbortController().signal);
    if (!e.ok) throw new Error(e.error.message);
    extractions.push(e.value);
  }
  expect(existsSync(path.join(root, 'node_modules'))).toBe(true);
  return { manifest, extractions };
}

describe('A-06: TypeScript configuration cannot load plugins', () => {
  it('positive control: the canary writes its marker when the plugin is really loaded', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cie-a06-control-'));
    temps.push(root);
    writeTree(root, INSTALLED);
    createRequire(path.join(root, 'package.json'))('evil-plugin');
    expect(existsSync(path.join(root, 'PWNED-installed'))).toBe(true);
  });

  it('resolves the workspace without loading any plugin or extended package code', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cie-a06-'));
    temps.push(root);
    writeTree(root, { ...SNAPSHOT, ...INSTALLED });
    const { manifest, extractions } = await extractAll(root);
    const resolver = LangTsResolver.create();
    if (!resolver.ok) throw new Error(resolver.error.message);
    const cacheBefore = new Set(Object.keys(createRequire(import.meta.url).cache));

    const r = await resolver.value.resolve({ manifest, extractions, fs: await GuardedFileSystem.open(root) }, new AbortController().signal);
    if (!r.ok) throw new Error(r.error.message);

    // Nothing was executed: no marker anywhere, no new module in the CommonJS cache.
    expect(readdirSync(root).filter((n) => n.startsWith('PWNED'))).toEqual([]);
    const loaded = Object.keys(createRequire(import.meta.url).cache).filter((k) => !cacheBefore.has(k) && k.includes('evil'));
    expect(loaded).toEqual([]);
    // Resolution itself still worked: the extended config was read as data, imports were resolved.
    const edges = r.value.edges.filter((e) => e.type === 'imports' && e.from === 'mod:ts:src/a.ts').map((e) => `${e.toKind} ${e.to.split('#')[0]} ${e.status}`);
    // The workspace package resolves through the virtual node_modules alias: read as data, never executed.
    expect(edges).toEqual(['module mod:ts:src/b.ts verified', 'external ext:npm:evil-plugin verified', 'module mod:js:tools/evil/index.js verified']);
    // A-06, Program path (P03-01): this binding is exact only if a Program and its TypeChecker were built for the
    // project whose tsconfig declares the plugins. They were, and still nothing was loaded (checked above).
    const binding = r.value.edges.find((e) => e.type === 'imports_symbol' && e.from === 'mod:ts:src/a.ts');
    expect([binding?.to, binding?.precision]).toEqual(['ts:src/b.ts#b(constant)', 'exact']);
    expect(r.value.diagnostics.filter((d) => d.code === 'TSCONFIG_ERROR').map((d) => d.message)).toEqual([]);
  });
});
