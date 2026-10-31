/**
 * Deterministic export (FR-002, NFR-023, WS-004): the same tree and configuration give byte-identical
 * output on every run and every OS. No timestamps, workspace ids, absolute paths or holder ids appear in it.
 */
import { NodeHasher } from '@cie/adapters';
import { buildManifest, domainError, err, ok, type DomainError, type Result } from '@cie/core';
import type { DevRuntime } from '../composition/dev-runtime.js';

export const EXPORT_FORMAT = 'cie-export/1';

export async function exportHead(rt: DevRuntime): Promise<Result<string, DomainError>> {
  const head = await rt.index.store.head();
  if (head === null) return err(domainError('INDEX_NOT_READY', 'nothing has been published yet'));
  const files = await rt.index.store.filesAt(head.seq);
  if (!files.ok) return files;
  const structure = await rt.index.store.structureAt(head.seq);
  if (!structure.ok) return structure;
  const manifest = buildManifest(files.value, new NodeHasher());
  if (!manifest.ok) return manifest;
  const doc = {
    format: EXPORT_FORMAT,
    revision: head.seq,
    manifestHash: manifest.value.manifestHash,
    files: manifest.value.entries,
    structure: structure.value,
  };
  return ok(`${JSON.stringify(doc, null, 2)}\n`);
}
