/**
 * Decoded source text with LSP-compatible positions (SourceRange: 0-based lines, UTF-16 columns,
 * end-exclusive). Line terminators are `\r\n`, `\n` and `\r`, as in LSP. A terminator belongs to the line it
 * ends, so a column can point at most to the start of the terminator (`col <= lineLength`).
 *
 * This is the single definition of "text(file, range)" for SY-003: extractors turn parser offsets into
 * ranges with it, and the validator turns ranges back into text with it.
 */
import type { ContentHash, DomainError, Hasher, Result, SourceRange } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';

export class SourceText {
  /** Offset of the first code unit of each line. */
  private readonly starts: readonly number[];
  /** Offset just past the last content code unit of each line (before its terminator). */
  private readonly ends: readonly number[];

  constructor(readonly text: string) {
    const starts = [0];
    const ends: number[] = [];
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 0x0a && c !== 0x0d) continue;
      ends.push(i);
      if (c === 0x0d && text.charCodeAt(i + 1) === 0x0a) i++;
      starts.push(i + 1);
    }
    ends.push(text.length);
    this.starts = starts;
    this.ends = ends;
  }

  get lineCount(): number {
    return this.starts.length;
  }

  /** Length of a line in UTF-16 code units, excluding its terminator; -1 for a line that does not exist. */
  lineLength(line: number): number {
    const s = this.starts[line];
    const e = this.ends[line];
    return s === undefined || e === undefined ? -1 : e - s;
  }

  /** Line and column of an offset. An offset inside a `\r\n` pair maps to the end of the line's content. */
  position(offset: number): { readonly line: number; readonly col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((this.starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    const start = this.starts[lo] as number;
    return { line: lo, col: Math.min(offset, this.ends[lo] as number) - start };
  }

  /** Range of the half-open offset interval [start, end). */
  rangeOf(start: number, end: number): SourceRange {
    const a = this.position(start);
    const b = this.position(end);
    return { startLine: a.line, startCol: a.col, endLine: b.line, endCol: b.col };
  }

  /** Offset of a position, or null when the position is outside the text (SY-003 a). */
  offsetOf(line: number, col: number): number | null {
    const len = this.lineLength(line);
    if (len < 0 || !Number.isSafeInteger(col) || col < 0 || col > len) return null;
    return (this.starts[line] as number) + col;
  }

  /** The text covered by a range, or null when the range is out of bounds or inverted. */
  slice(range: SourceRange): string | null {
    const a = this.offsetOf(range.startLine, range.startCol);
    const b = this.offsetOf(range.endLine, range.endCol);
    return a === null || b === null || a > b ? null : this.text.slice(a, b);
  }

  /** spanHash per SY-003 (b): sha256 of the UTF-8 encoding of the text in `range`. */
  spanHash(range: SourceRange, hasher: Hasher): Result<ContentHash, DomainError> {
    const t = this.slice(range);
    if (t === null) return err(domainError('SY_003_OUT_OF_BOUNDS', 'range lies outside the file content', { ...range }));
    return ok(hasher.sha256Text(t));
  }
}

export interface SpannedRecord {
  readonly id: string;
  readonly range: SourceRange;
  readonly spanHash: ContentHash;
}

/**
 * SY-003 validator: every record's range lies within the text, and its spanHash matches the text it covers.
 * `sample` limits rehashing to a deterministic subset (every k-th record, k = ceil(n / sample)); bounds are
 * always checked for every record.
 */
export function spanViolations(text: SourceText, records: readonly SpannedRecord[], hasher: Hasher, sample?: number): readonly string[] {
  const out: string[] = [];
  const step = sample === undefined || sample >= records.length ? 1 : Math.max(1, Math.ceil(records.length / Math.max(1, sample)));
  records.forEach((r, i) => {
    const span = text.slice(r.range);
    if (span === null) {
      out.push(`SY-003: ${r.id} range ${r.range.startLine}:${r.range.startCol}-${r.range.endLine}:${r.range.endCol} is outside the file`);
    } else if (i % step === 0 && hasher.sha256Text(span) !== r.spanHash) {
      out.push(`SY-003: ${r.id} spanHash does not match the text in its range`);
    }
  });
  return out;
}
