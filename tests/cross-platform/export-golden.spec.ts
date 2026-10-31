// P01-14, P02-11, FF-DAT-006, WS-004: the export of every golden fixture is byte-identical to its committed
// golden file on every CI cell (windows/ubuntu x Node 24/26) and across independent runs, and it satisfies
// every rule of docs/specs/EXPORT_FORMAT.md (cie-export/2: files, structure, code nodes and edges).
// To regenerate the golden files deliberately: CIE_UPDATE_GOLDEN=1 npx vitest run tests/cross-platform
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CLI_TEST_TIMEOUT_MS, runCli } from '../helpers/cli.js';
import { GOLDEN_FIXTURES } from '../helpers/golden.js';
import { repoPath } from '../helpers/repo.js';

vi.setConfig({ testTimeout: CLI_TEST_TIMEOUT_MS });

const scratch = mkdtempSync(path.join(tmpdir(), 'cie-xplat-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function exportFresh(fixture: string, name: string): Buffer {
  const workspace = repoPath(`fixtures/${fixture}`);
  const stateDir = path.join(scratch, `${fixture}-${name}`);
  const env = { CIE_CONFIG_DIR: path.join(scratch, 'user-config') };
  const indexed = runCli(['dev', 'index', '--workspace', workspace, '--state-dir', stateDir], env);
  if (indexed.code !== 0) throw new Error(indexed.stderr);
  const r = runCli(['dev', 'export', '--workspace', workspace, '--state-dir', stateDir], env);
  if (r.code !== 0) throw new Error(r.stderr);
  return Buffer.from(r.stdout, 'utf8');
}

type Obj = Record<string, unknown>;
interface ExportDoc {
  format: string;
  revision: number;
  manifestHash: string;
  files: Obj[];
  structure: Obj[];
  nodes: Obj[];
  edges: Obj[];
}
const codeUnitSorted = (xs: readonly string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const RANGE_KEYS = ['startLine', 'startCol', 'endLine', 'endCol'];
const PRODUCER_KEYS = ['adapterId', 'adapterVersion', 'toolVersion', 'fidelity'];
const CANONICAL_PATH = /^(?!\/)(?![A-Za-z]:)(?!.*\\)(?!.*(^|\/)\.{1,2}(\/|$)).+$/;

for (const fixture of GOLDEN_FIXTURES) {
  describe(`export golden: ${fixture}`, () => {
    let first: Buffer;
    let text: string;
    let doc: ExportDoc;
    const load = () => {
      first ??= exportFresh(fixture, 'a');
      text = first.toString('utf8');
      doc = JSON.parse(text) as ExportDoc;
    };

    it('is byte-identical to the committed golden file and across independent runs', () => {
      load();
      const golden = repoPath(`fixtures/${fixture}.export.json`);
      if (process.env['CIE_UPDATE_GOLDEN'] === '1') writeFileSync(golden, first);
      expect(first.equals(readFileSync(golden)), `export differs from fixtures/${fixture}.export.json`).toBe(true);
      expect(exportFresh(fixture, 'b').equals(first)).toBe(true);
    });

    it('E1/E2/L1-L3: UTF-8 without BOM, NFC paths, LF only, one final newline, 2-space JSON', () => {
      load();
      expect(first.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
      expect(Buffer.from(text, 'utf8').equals(first)).toBe(true);
      const paths = [...doc.files.map((f) => f['path']), ...doc.nodes.map((n) => n['file']).filter((f) => f !== null)] as string[];
      for (const p of paths) expect(p.normalize('NFC'), p).toBe(p);
      expect(first.includes(0x0d)).toBe(false);
      expect(text.endsWith('}\n') && !text.endsWith('\n\n')).toBe(true);
      expect(text).toBe(`${JSON.stringify(doc, null, 2)}\n`);
    });

    it('S1-S3: declared key order, explicit nulls, integer numbers, fresh revision 1', () => {
      load();
      expect(Object.keys(doc)).toEqual(['format', 'revision', 'manifestHash', 'files', 'structure', 'nodes', 'edges']);
      expect([doc.format, doc.revision]).toEqual(['cie-export/2', 1]);
      for (const f of doc.files) {
        expect(Object.keys(f)).toEqual(f['status'] === 'indexed' ? ['path', 'status', 'hash', 'size', 'language'] : ['path', 'status', 'reason', 'size']);
        expect(Number.isSafeInteger(f['size'])).toBe(true);
      }
      for (const n of doc.structure) expect(Object.keys(n)).toEqual(['id', 'kind', 'name', 'ecosystem', 'file']);
      for (const n of doc.nodes) {
        expect(Object.keys(n)).toEqual(['id', 'kind', 'name', 'file', 'language', 'symbol', 'producer']);
        expect(Object.keys(n['producer'] as Obj)).toEqual(PRODUCER_KEYS);
        const s = n['symbol'] as Obj | null;
        expect(s === null, String(n['id'])).toBe(n['kind'] !== 'symbol');
        if (s === null) continue;
        expect(Object.keys(s)).toEqual(['qualifiedName', 'kind', 'range', 'spanHash', 'bodyFingerprint', 'exported', 'doc']);
        expect(Object.keys(s['range'] as Obj)).toEqual(RANGE_KEYS);
        for (const v of Object.values(s['range'] as Obj)) expect(Number.isSafeInteger(v) && (v as number) >= 0).toBe(true);
      }
      for (const e of doc.edges) {
        expect(Object.keys(e)).toEqual(['type', 'from', 'to', 'site', 'status', 'precision', 'producer', 'evidence', 'attrs']);
        const ev = e['evidence'] as Obj | null;
        if (ev !== null) {
          expect(Object.keys(ev)).toEqual(['kind', 'path', 'range', 'contentHash']);
          expect(Object.keys(ev['range'] as Obj)).toEqual(RANGE_KEYS);
        }
        const attrKeys = Object.keys(e['attrs'] as Obj);
        expect(attrKeys).toEqual(codeUnitSorted(attrKeys));
      }
    });

    it('P1/O1-O4: canonical paths; files, structure, nodes and edges in UTF-16 code-unit order', () => {
      load();
      const paths = doc.files.map((f) => f['path'] as string);
      for (const p of paths) expect(p).toMatch(CANONICAL_PATH);
      expect(paths).toEqual(codeUnitSorted(paths));
      for (const list of [doc.structure, doc.nodes]) {
        const ids = list.map((n) => n['id'] as string);
        expect(ids).toEqual(codeUnitSorted(ids));
      }
      const keys = doc.edges.map((e) => [e['type'], e['from'], e['to'], e['site']].join('\u0000'));
      expect(keys).toEqual(codeUnitSorted(keys));
    });

    it('F1-F4: no absolute paths, timestamps, ids, host or user names', () => {
      load();
      const workspace = repoPath(`fixtures/${fixture}`);
      const forbidden = [workspace, scratch, homedir(), tmpdir(), workspace.replaceAll('\\', '/'), tmpdir().replaceAll('\\', '/')];
      for (const s of forbidden) expect(text.includes(s), `contains ${s}`).toBe(false);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      expect(text).not.toMatch(/ws_[0-9a-f]{8}-/);
      expect(text).not.toMatch(/job_[0-9a-f]{8}-|\|\d+\|/);
    });

    if (fixture === 'xplat-basic') {
      it('covers the cross-platform edge cases the fixture was built for', () => {
        load();
        const byPath = new Map(doc.files.map((f) => [f['path'] as string, f]));
        expect(byPath.get('crlf.txt')).toMatchObject({ status: 'indexed', size: 20 }); // CRLF bytes preserved
        expect(byPath.get('image.bin')).toMatchObject({ status: 'skipped', reason: 'binary' });
        expect(byPath.get('big.ts')).toMatchObject({ status: 'skipped', reason: 'too_large', size: 301 });
        expect(byPath.get('src/caf\u00e9.ts')).toMatchObject({ status: 'indexed', language: 'ts' });
        expect(byPath.get('src/sub/keep.log')).toMatchObject({ status: 'indexed' });
        for (const ignored of ['src/sub/drop.log', 'build/out.js', 'generated/x.ts']) expect(byPath.has(ignored), ignored).toBe(false);
        expect([...byPath.keys()].indexOf('src/Upper.ts')).toBeLessThan([...byPath.keys()].indexOf('src/caf\u00e9.ts'));
        // Skipped and ignored files contribute no code nodes.
        expect(doc.nodes.some((n) => n['file'] === 'big.ts' || n['file'] === 'generated/x.ts')).toBe(false);
      });
    }
  });
}
