// WS-004: deterministic enumeration. For an identical tree and configuration, the manifest (order and
// content) and its manifestHash are byte-identical across runs, OSes and locales.
// Enumeration itself (walking the tree) arrives with GuardedFileSystem (P01-06). This file pins the
// manifest half: ordering, serialization and hashing. The CI matrix runs it on Windows and Linux.
import { createHash } from 'node:crypto';
import { NodeHasher } from '@cie/adapters';
import {
  buildManifest,
  canonicalizePath,
  parseContentHash,
  serializeManifest,
  type CanonicalPath,
  type ContentHash,
  type ManifestEntry,
} from '@cie/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

const hasher = new NodeHasher();

function path(raw: string): CanonicalPath {
  const r = canonicalizePath(raw);
  if (!r.ok) throw new Error(`fixture path rejected: ${raw}`);
  return r.value;
}
function hash(hex: string): ContentHash {
  const r = parseContentHash(`sha256:${hex.repeat(64 / hex.length)}`);
  if (!r.ok) throw new Error('fixture hash rejected');
  return r.value;
}

// Paths chosen so that locale collation, code-point order and UTF-16 code-unit order all disagree:
// '-' (0x2d) < '/' (0x2f); uppercase < '_' < lowercase; U+1F600 (UTF-16 0xD83D…) < U+FF71 in code units,
// although it is larger as a code point.
const fixture: ManifestEntry[] = [
  { path: path('src/b.ts'), status: 'indexed', hash: hash('b'), size: 20, language: 'ts' },
  { path: path('\uff71.ts'), status: 'indexed', hash: hash('7'), size: 1, language: 'ts' },
  { path: path('a.ts'), status: 'indexed', hash: hash('a'), size: 10, language: 'ts' },
  { path: path('\u{1f600}.py'), status: 'indexed', hash: hash('6'), size: 2, language: 'py' },
  { path: path('_x.ts'), status: 'indexed', hash: hash('5'), size: 5, language: 'ts' },
  { path: path('src-b/a.ts'), status: 'indexed', hash: hash('c'), size: 30, language: 'ts' },
  { path: path('B.md'), status: 'indexed', hash: hash('d'), size: 3, language: null },
  { path: path('src/a.ts'), status: 'skipped', reason: 'too_large', size: 9_000_000 },
  { path: path('\u00e9.ts'), status: 'indexed', hash: hash('e'), size: 4, language: 'ts' },
  { path: path('Z.bin'), status: 'skipped', reason: 'binary', size: 7 },
];

// Expected serialization, written out by hand rather than produced by the code under test.
const expectedText = [
  'cie-manifest/1',
  `B.md\tindexed\tsha256:${'d'.repeat(64)}\t3\t`,
  'Z.bin\tskipped\tbinary\t7\t',
  `_x.ts\tindexed\tsha256:${'5'.repeat(64)}\t5\tts`,
  `a.ts\tindexed\tsha256:${'a'.repeat(64)}\t10\tts`,
  `src-b/a.ts\tindexed\tsha256:${'c'.repeat(64)}\t30\tts`,
  'src/a.ts\tskipped\ttoo_large\t9000000\t',
  `src/b.ts\tindexed\tsha256:${'b'.repeat(64)}\t20\tts`,
  `\u00e9.ts\tindexed\tsha256:${'e'.repeat(64)}\t4\tts`,
  `\u{1f600}.py\tindexed\tsha256:${'6'.repeat(64)}\t2\tpy`,
  `\uff71.ts\tindexed\tsha256:${'7'.repeat(64)}\t1\tts`,
  '',
].join('\n');
const expectedHash = `sha256:${createHash('sha256').update(expectedText, 'utf8').digest('hex')}`;

describe('WS-004: deterministic manifest', () => {
  it('orders by UTF-16 code units and serializes to the exact expected text', () => {
    const r = buildManifest(fixture, hasher);
    if (!r.ok) throw new Error(r.error.message);
    expect(serializeManifest(r.value.entries)).toBe(expectedText);
    expect(r.value.manifestHash).toBe(expectedHash);
  });

  it('does not depend on input order (property)', () => {
    fc.assert(
      fc.property(fc.shuffledSubarray(fixture, { minLength: fixture.length, maxLength: fixture.length }), (shuffled) => {
        const r = buildManifest(shuffled, hasher);
        expect(r.ok && r.value.manifestHash).toBe(expectedHash);
      }),
      { seed: 20261031, numRuns: 200 },
    );
  });

  it('treats NFD and NFC spellings of a name as the same path (reported as a duplicate)', () => {
    const nfd = { ...fixture[0], path: path('e\u0301.ts') } as ManifestEntry;
    const r = buildManifest([...fixture, nfd], hasher);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MANIFEST_DUPLICATE_PATH');
  });

  it('rejects invalid sizes', () => {
    const bad = { ...fixture[2], size: -1 } as ManifestEntry;
    const r = buildManifest([bad], hasher);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('MANIFEST_INVALID_SIZE');
  });

  it('changes the hash when any entry changes', () => {
    const base = buildManifest(fixture, hasher);
    const changed = buildManifest([{ ...fixture[2], size: 11 } as ManifestEntry, ...fixture.slice(3), ...fixture.slice(0, 2)], hasher);
    expect(base.ok && changed.ok && base.value.manifestHash !== changed.value.manifestHash).toBe(true);
  });
});
