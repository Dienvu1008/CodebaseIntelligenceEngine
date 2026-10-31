/**
 * SY-003 (b) at publish: the RevisionValidator's span-hash check (DOMAIN_INVARIANTS SY-003). The store
 * checks bounds for every symbol from the stored line counts; this module rehashes a deterministic sample
 * of the stored symbols against the file content, so a range or span hash that does not describe the text
 * it claims aborts the publish.
 *
 *  - The sample comes from the store (what will be published), not from the in-memory graph.
 *  - Bytes are re-read through the FileSystem port. A file whose bytes no longer hash to the stored file
 *    version changed after enumeration: its symbols are unverifiable here, not violations (the next run
 *    re-extracts it). A file that cannot be read is unverifiable too.
 *  - Decoding mirrors the extractors (CODE_INTELLIGENCE_STRATEGY §6.1): a UTF-8 or UTF-16 BOM is not part of
 *    the text. Extracted content is valid in its encoding (extractors reject anything else), and on valid
 *    input this decoder gives the same text as theirs.
 */
import { SourceText, spanViolations } from '../../code-intelligence/public.js';
import type { CancellationSignal, CanonicalPath, DomainError, Hasher, Result, RevisionSeq } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import { decodeUtf8, type FileSystem } from '../../workspace/public.js';
import type { RevisionWriter, StoredSpan } from './ports.js';

/** Default number of span hashes recomputed per publish. Bounds are always checked for every symbol. */
export const DEFAULT_SPAN_SAMPLE = 200;

export interface SpanCheckDeps {
  readonly store: Pick<RevisionWriter, 'sampleSpans'>;
  readonly fs: FileSystem;
  readonly hasher: Hasher;
  readonly signal: CancellationSignal;
}

export interface SpanCheckOutcome {
  /** Symbols visible in the revision. */
  readonly total: number;
  /** Span hashes recomputed. */
  readonly checked: number;
  /** Sampled symbols whose file changed or could not be read after enumeration. */
  readonly unverifiable: number;
  readonly violations: readonly string[];
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string | null {
  if (bytes.length % 2 !== 0) return null;
  const units: number[] = [];
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    const a = bytes[i] as number;
    const b = bytes[i + 1] as number;
    units.push(littleEndian ? a | (b << 8) : (a << 8) | b);
    if (units.length === 4096) {
      out += String.fromCharCode(...units);
      units.length = 0;
    }
  }
  return out + String.fromCharCode(...units);
}

/** Decoded text the way extractors see it (BOM excluded), or null for content no extractor accepts. */
export function decodeForSpanCheck(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return decodeUtf8(bytes.subarray(3));
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return decodeUtf16(bytes.subarray(2), true);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return decodeUtf16(bytes.subarray(2), false);
  return decodeUtf8(bytes);
}

function byFile(records: readonly StoredSpan[]): Map<CanonicalPath, StoredSpan[]> {
  const out = new Map<CanonicalPath, StoredSpan[]>();
  for (const r of records) {
    const list = out.get(r.path);
    if (list === undefined) out.set(r.path, [r]);
    else list.push(r);
  }
  return out;
}

/** Rehashes the sampled spans of revision `seq` (`sample` null: all of them) against the workspace files. */
export async function verifySpans(deps: SpanCheckDeps, seq: RevisionSeq, sample: number | null): Promise<Result<SpanCheckOutcome, DomainError>> {
  const sampled = await deps.store.sampleSpans(seq, sample);
  if (!sampled.ok) return sampled;
  const violations: string[] = [];
  let checked = 0;
  let unverifiable = 0;
  for (const [path, records] of byFile(sampled.value.records)) {
    if (deps.signal.aborted) return err(domainError('INDEX_CANCELLED', 'indexing was cancelled'));
    const fileHash = records[0]?.fileHash ?? null;
    if (fileHash === null) {
      for (const r of records) violations.push(`SY-003: symbol ${r.id} has no visible file version for ${path}`);
      continue;
    }
    const bytes = await deps.fs.readFile(path, deps.signal);
    if (!bytes.ok || deps.hasher.sha256(bytes.value) !== fileHash) {
      unverifiable += records.length;
      continue;
    }
    const text = decodeForSpanCheck(bytes.value);
    if (text === null) {
      violations.push(`SY-003: ${path} has symbols but its content cannot be decoded`);
      continue;
    }
    violations.push(...spanViolations(new SourceText(text), records, deps.hasher));
    checked += records.length;
  }
  return ok({ total: sampled.value.total, checked, unverifiable, violations });
}
