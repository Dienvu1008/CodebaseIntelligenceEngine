// Spike S2 (Phase 02 entry, checklist P02-01; assumption A-01, OQ-09 option A).
// Question: do the vendored tree-sitter grammar artifacts load under web-tree-sitter on every CI cell
// (windows/ubuntu x Node 24/26), parse TS/TSX/JS/Python without errors and answer queries? This test stays
// as a permanent canary for grammar upgrades (ADR-0010 §"Upgrade procedure"), and it pins the loader's
// contract: verify integrity at first load, then serve the cached Language without hashing again.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GrammarLoader, parseGrammarLock, VENDORED_GRAMMARS_DIR, type GrammarLock } from '@cie/adapters';
import type { ContentHash, Hasher } from '@cie/core';
import { Parser, Query } from 'web-tree-sitter';
import { afterAll, describe, expect, it } from 'vitest';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const lock = JSON.parse(readFileSync(path.join(VENDORED_GRAMMARS_DIR, 'grammars.lock.json'), 'utf8')) as GrammarLock;
const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});

/** Copy of the vendored directory, so a test can tamper with it. */
function copyVendored(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'cie-s2-'));
  temps.push(dir);
  for (const f of readdirSync(VENDORED_GRAMMARS_DIR)) copyFileSync(path.join(VENDORED_GRAMMARS_DIR, f), path.join(dir, f));
  return dir;
}

class CountingHasher implements Hasher {
  calls = 0;
  sha256(data: Uint8Array): ContentHash {
    this.calls++;
    return `sha256:${sha256(data)}` as ContentHash;
  }
  sha256Text(text: string): ContentHash {
    return this.sha256(new TextEncoder().encode(text));
  }
}

const SAMPLES: Record<string, { code: string; query: string; names: string[] }> = {
  typescript: {
    code: 'export interface Shape { area(): number }\nexport class Square implements Shape {\n  constructor(private readonly side: number) {}\n  area(): number { return this.side ** 2; }\n}\nexport function total<T extends Shape>(xs: readonly T[]): number { return xs.reduce((s, x) => s + x.area(), 0); }\n',
    query: '(class_declaration name: (type_identifier) @name) (function_declaration name: (identifier) @name) (interface_declaration name: (type_identifier) @name)',
    names: ['Shape', 'Square', 'total'],
  },
  tsx: {
    code: 'type Props = { label: string };\nexport function Button({ label }: Props) { return <button aria-label={label}>{label}</button>; }\n',
    query: '(function_declaration name: (identifier) @name)',
    names: ['Button'],
  },
  javascript: {
    code: 'export class Queue { #items = []; push(x) { this.#items.push(x); } }\nexport const drain = async function* (q) { yield* q; };\nfunction helper() {}\n',
    query: '(class_declaration name: (identifier) @name) (function_declaration name: (identifier) @name)',
    names: ['Queue', 'helper'],
  },
  python: {
    code: 'from dataclasses import dataclass\n\n@dataclass\nclass Point:\n    x: float\n    y: float\n\n    def norm(self) -> float:\n        return (self.x ** 2 + self.y ** 2) ** 0.5\n\nasync def main() -> None:\n    match Point(1, 2):\n        case Point(x=1):\n            pass\n',
    query: '(class_definition name: (identifier) @name) (function_definition name: (identifier) @name)',
    names: ['Point', 'main', 'norm'],
  },
};

describe(`spike S2 on ${process.platform}-${process.arch}, Node ${process.versions.node}`, () => {
  const loader = new GrammarLoader();

  it('vendors exactly the artifacts, licenses and attribution that the lock describes', () => {
    expect(parseGrammarLock(lock).ok).toBe(true);
    const expected = new Set(['grammars.lock.json', 'ATTRIBUTION.md']);
    for (const g of lock.grammars) {
      const wasm = readFileSync(path.join(VENDORED_GRAMMARS_DIR, g.artifact.file));
      expect({ file: g.artifact.file, bytes: wasm.length, sha256: sha256(wasm) }).toEqual(g.artifact);
      expect(sha256(readFileSync(path.join(VENDORED_GRAMMARS_DIR, g.license.file)))).toBe(g.license.sha256);
      expect(g.source.integrity).toMatch(/^sha512-/);
      expected.add(g.artifact.file).add(g.license.file);
    }
    expect(new Set(readdirSync(VENDORED_GRAMMARS_DIR))).toEqual(expected);
    expect(lock.grammars.map((g) => g.language).sort()).toEqual(['javascript', 'python', 'tsx', 'typescript']);
  });

  it('records the web-tree-sitter version that @cie/adapters pins', () => {
    const pkg = JSON.parse(readFileSync(path.join(VENDORED_GRAMMARS_DIR, '..', 'package.json'), 'utf8')) as { dependencies: Record<string, string> };
    expect(lock.runtime).toEqual({ package: 'web-tree-sitter', version: pkg.dependencies['web-tree-sitter'] });
  });

  for (const [language, sample] of Object.entries(SAMPLES)) {
    it(`loads ${language}, parses without errors and answers a query`, async () => {
      const loaded = await loader.load(language);
      if (!loaded.ok) throw new Error(JSON.stringify(loaded.error));
      const entry = lock.grammars.find((g) => g.language === language);
      expect(loaded.value.abiVersion).toBe(entry?.abi);
      console.log(`[S2] ${language}: abi=${loaded.value.abiVersion} ${entry?.source.package}@${entry?.source.version}`);

      const parser = new Parser();
      const query = new Query(loaded.value, sample.query);
      try {
        parser.setLanguage(loaded.value);
        const tree = parser.parse(sample.code);
        if (tree === null) throw new Error('parse returned null');
        expect(tree.rootNode.hasError).toBe(false);
        const names = query.captures(tree.rootNode).map((c) => c.node.text);
        expect([...new Set(names)].sort()).toEqual(sample.names);
        tree.delete();
      } finally {
        query.delete();
        parser.delete();
      }
    });
  }

  it('verifies once per loader, then serves the cached Language without hashing again', async () => {
    const hasher = new CountingHasher();
    const fresh = new GrammarLoader({ hasher });
    const [a, b] = await Promise.all([fresh.load('python'), fresh.load('python')]);
    const c = await fresh.load('python');
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(a.ok && b.ok && c.ok && a.value === b.value && b.value === c.value).toBe(true);
    expect(hasher.calls).toBe(1);
    await fresh.load('javascript');
    expect(hasher.calls).toBe(2);
  });

  it('rejects a tampered artifact with GRAMMAR_INTEGRITY_MISMATCH', async () => {
    const dir = copyVendored();
    const file = path.join(dir, 'tree-sitter-python.wasm');
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 0xff; // same size, different content
    writeFileSync(file, bytes);
    const result = await new GrammarLoader({ dir }).load('python');
    expect(result.ok ? undefined : result.error.code).toBe('GRAMMAR_INTEGRITY_MISMATCH');
  });

  it('rejects a truncated artifact without hashing it', async () => {
    const dir = copyVendored();
    const file = path.join(dir, 'tree-sitter-javascript.wasm');
    writeFileSync(file, readFileSync(file).subarray(0, 1024));
    const hasher = new CountingHasher();
    const result = await new GrammarLoader({ dir, hasher }).load('javascript');
    expect(result.ok ? undefined : result.error.code).toBe('GRAMMAR_INTEGRITY_MISMATCH');
    expect(hasher.calls).toBe(0);
  });

  it('does not cache a failure: a repaired artifact loads on the next call', async () => {
    const dir = copyVendored();
    const file = path.join(dir, 'tree-sitter-tsx.wasm');
    const good = readFileSync(file);
    writeFileSync(file, Buffer.from('not wasm'));
    const fresh = new GrammarLoader({ dir });
    expect((await fresh.load('tsx')).ok).toBe(false);
    writeFileSync(file, good);
    expect((await fresh.load('tsx')).ok).toBe(true);
  });

  it('reports unknown languages and unsafe or malformed lock files', async () => {
    const unknown = await loader.load('dart');
    expect(unknown.ok ? undefined : unknown.error.code).toBe('GRAMMAR_UNKNOWN_LANGUAGE');

    const [first] = lock.grammars;
    if (first === undefined) throw new Error('empty lock');
    const traversal = { ...lock, grammars: [{ ...first, artifact: { ...first.artifact, file: '../escape.wasm' } }] };
    expect(parseGrammarLock(traversal).ok).toBe(false);
    expect(parseGrammarLock({ ...lock, grammars: [first, first] }).ok).toBe(false);
    expect(parseGrammarLock({ ...lock, format: 'cie-grammars/0' }).ok).toBe(false);

    const dir = copyVendored();
    writeFileSync(path.join(dir, 'grammars.lock.json'), '{ not json');
    const broken = await new GrammarLoader({ dir }).load('python');
    expect(broken.ok ? undefined : broken.error.code).toBe('GRAMMAR_LOCK_INVALID');
  });
});
