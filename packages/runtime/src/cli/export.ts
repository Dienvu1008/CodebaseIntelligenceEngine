/**
 * Deterministic export (FR-002, NFR-023, WS-004, FF-DAT-006; docs/specs/EXPORT_FORMAT.md): the same tree and
 * configuration give byte-identical output on every run and every OS. No timestamps, workspace ids, absolute
 * paths or holder ids appear in it.
 *
 * `cie-export/2` (Phase 02) adds the code graph: `nodes` (module, symbol, external, unresolved) and `edges`.
 * Every object is rebuilt here with its declared key order, so the export never depends on how a record was
 * serialized in storage.
 */
import { NodeHasher } from '@cie/adapters';
import { buildManifest, domainError, err, ok, type CodeEdge, type CodeNode, type DomainError, type ProducerRef, type Result, type SourceRange } from '@cie/core';
import type { DevRuntime } from '../composition/dev-runtime.js';

export const EXPORT_FORMAT = 'cie-export/2';

const range = (r: SourceRange) => ({ startLine: r.startLine, startCol: r.startCol, endLine: r.endLine, endCol: r.endCol });
const producer = (p: ProducerRef) => ({ adapterId: p.adapterId, adapterVersion: p.adapterVersion, toolVersion: p.toolVersion, fidelity: p.fidelity });

export function exportNode(n: CodeNode) {
  const s = n.symbol;
  return {
    id: n.id,
    kind: n.kind,
    name: n.name,
    file: n.file,
    language: n.language,
    symbol:
      s === null
        ? null
        : { qualifiedName: s.qualifiedName, kind: s.kind, range: range(s.range), spanHash: s.spanHash, bodyFingerprint: s.bodyFingerprint, exported: s.exported, doc: s.doc },
    producer: producer(n.producer),
  };
}

const byCodeUnit = (a: string, b: string): number => (a === b ? 0 : a < b ? -1 : 1);

export function exportEdge(e: CodeEdge) {
  const ev = e.evidence;
  // attrs keys in UTF-16 order; values are strings, booleans or null.
  const attrs = Object.fromEntries(Object.entries(e.attrs).sort(([a], [b]) => byCodeUnit(a, b)));
  return {
    type: e.type,
    from: e.from,
    to: e.to,
    site: e.site,
    status: e.status,
    precision: e.precision,
    producer: producer(e.producer),
    evidence: ev === null ? null : { kind: ev.kind, path: ev.path, range: range(ev.range), contentHash: ev.contentHash },
    attrs,
  };
}

/** Edge order: (type, from, to, site) compared field by field in UTF-16 code-unit order. */
export function compareEdges(a: CodeEdge, b: CodeEdge): number {
  return byCodeUnit(a.type, b.type) || byCodeUnit(a.from, b.from) || byCodeUnit(a.to, b.to) || byCodeUnit(a.site, b.site);
}

export async function exportHead(rt: DevRuntime): Promise<Result<string, DomainError>> {
  const head = await rt.index.store.head();
  if (head === null) return err(domainError('INDEX_NOT_READY', 'nothing has been published yet'));
  const files = await rt.index.store.filesAt(head.seq);
  if (!files.ok) return files;
  const structure = await rt.index.store.structureAt(head.seq);
  if (!structure.ok) return structure;
  const graph = await rt.index.store.graphAt(head.seq);
  if (!graph.ok) return graph;
  const manifest = buildManifest(files.value, new NodeHasher());
  if (!manifest.ok) return manifest;
  const doc = {
    format: EXPORT_FORMAT,
    revision: head.seq,
    manifestHash: manifest.value.manifestHash,
    files: manifest.value.entries,
    structure: structure.value,
    nodes: [...graph.value.nodes].sort((a, b) => byCodeUnit(a.id, b.id)).map(exportNode),
    edges: [...graph.value.edges].sort(compareEdges).map(exportEdge),
  };
  return ok(`${JSON.stringify(doc, null, 2)}\n`);
}
