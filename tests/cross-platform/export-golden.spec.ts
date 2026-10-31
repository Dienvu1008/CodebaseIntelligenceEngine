// P01-14, FF-DAT-006, WS-004: the export of fixtures/xplat-basic is byte-identical to the committed golden
// file on every CI cell (windows/ubuntu x Node 24/26), and it satisfies every rule of
// docs/specs/EXPORT_FORMAT.md.
// To regenerate the golden file deliberately: CIE_UPDATE_GOLDEN=1 npx vitest run tests/cross-platform
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CLI_TEST_TIMEOUT_MS, runCli } from '../helpers/cli.js';

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS });
import { repoPath } from '../helpers/repo.js';

const FIXTURE = repoPath('fixtures/xplat-basic');
const GOLDEN = repoPath('fixtures/xplat-basic.export.json');
const scratch = mkdtempSync(path.join(tmpdir(), 'cie-xplat-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function exportFresh(name: string): Buffer {
  const stateDir = path.join(scratch, name);
  const env = { CIE_CONFIG_DIR: path.join(scratch, 'user-config') };
  const indexed = runCli(['dev', 'index', '--workspace', FIXTURE, '--state-dir', stateDir], env);
  if (indexed.code !== 0) throw new Error(indexed.stderr);
  const r = runCli(['dev', 'export', '--workspace', FIXTURE, '--state-dir', stateDir], env);
  if (r.code !== 0) throw new Error(r.stderr);
  return Buffer.from(r.stdout, 'utf8');
}

const first = exportFresh('a');
const text = first.toString('utf8');
const doc = JSON.parse(text) as {
  format: string;
  revision: number;
  manifestHash: string;
  files: Array<Record<string, unknown>>;
  structure: Array<Record<string, unknown>>;
};
const codeUnitSorted = (xs: readonly string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

describe('cross-platform export (golden)', () => {
  it('is byte-identical to the committed golden file', () => {
    if (process.env['CIE_UPDATE_GOLDEN'] === '1') writeFileSync(GOLDEN, first);
    const golden = readFileSync(GOLDEN);
    expect(first.equals(golden), 'export differs from fixtures/xplat-basic.export.json').toBe(true);
  });

  it('is identical across independent runs', () => {
    expect(exportFresh('b').equals(first)).toBe(true);
  });
});

describe('EXPORT_FORMAT rules', () => {
  it('E1/E2: UTF-8 without BOM, NFC strings', () => {
    expect(first.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(Buffer.from(text, 'utf8').equals(first)).toBe(true); // round-trips, so the bytes are valid UTF-8
    expect(text.normalize('NFC')).toBe(text);
  });

  it('L1/L2/L3: LF only, one final newline, 2-space JSON', () => {
    expect(first.includes(0x0d)).toBe(false);
    expect(text.endsWith('}\n') && !text.endsWith('\n\n')).toBe(true);
    expect(text).toBe(`${JSON.stringify(doc, null, 2)}\n`);
  });

  it('S1/S2/S3: declared key order, explicit nulls, integer numbers, fresh revision 1', () => {
    expect(Object.keys(doc)).toEqual(['format', 'revision', 'manifestHash', 'files', 'structure']);
    expect(doc.format).toBe('cie-export/1');
    expect(doc.revision).toBe(1);
    for (const f of doc.files) {
      expect(Object.keys(f)).toEqual(f['status'] === 'indexed' ? ['path', 'status', 'hash', 'size', 'language'] : ['path', 'status', 'reason', 'size']);
      expect(Number.isSafeInteger(f['size'])).toBe(true);
    }
    for (const n of doc.structure) expect(Object.keys(n)).toEqual(['id', 'kind', 'name', 'ecosystem', 'file']);
  });

  it('P1/O1/O2: canonical paths in UTF-16 code-unit order', () => {
    const paths = doc.files.map((f) => f['path'] as string);
    for (const p of paths) expect(p).toMatch(/^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(^|\/)\.{1,2}(\/|$)).+$/);
    expect(paths).toEqual(codeUnitSorted(paths));
    const ids = doc.structure.map((n) => n['id'] as string);
    expect(ids).toEqual(codeUnitSorted(ids));
  });

  it('F1-F4: no absolute paths, timestamps, ids, host or user names', () => {
    const forbidden = [FIXTURE, scratch, homedir(), tmpdir(), FIXTURE.replaceAll('\\', '/'), tmpdir().replaceAll('\\', '/')];
    for (const s of forbidden) expect(text.includes(s), `contains ${s}`).toBe(false);
    expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/); // ISO timestamps
    expect(text).not.toMatch(/ws_[0-9a-f]{8}-/); // workspace ids
    expect(text).not.toMatch(/job_[0-9a-f]{8}-|\|\d+\|/); // job ids, lease holders
  });

  it('covers the cross-platform edge cases the fixture was built for', () => {
    const byPath = new Map(doc.files.map((f) => [f['path'] as string, f]));
    expect(byPath.get('crlf.txt')).toMatchObject({ status: 'indexed', size: 20 }); // CRLF bytes preserved
    expect(byPath.get('image.bin')).toMatchObject({ status: 'skipped', reason: 'binary' });
    expect(byPath.get('big.ts')).toMatchObject({ status: 'skipped', reason: 'too_large', size: 301 });
    expect(byPath.get('src/caf\u00e9.ts')).toMatchObject({ status: 'indexed', language: 'ts' });
    expect(byPath.get('src/sub/keep.log')).toMatchObject({ status: 'indexed' });
    for (const ignored of ['src/sub/drop.log', 'build/out.js', 'generated/x.ts']) expect(byPath.has(ignored), ignored).toBe(false);
    expect([...byPath.keys()].indexOf('src/Upper.ts')).toBeLessThan([...byPath.keys()].indexOf('src/caf\u00e9.ts'));
  });
});
