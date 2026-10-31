import type { DomainError } from './domain-error.js';
import { domainError } from './domain-error.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

/** 0-based lines, UTF-16 code-unit columns, end-exclusive (LSP-compatible). */
export interface SourceRange {
  readonly startLine: number;
  readonly startCol: number;
  readonly endLine: number;
  readonly endCol: number;
}

function isNonNegativeInt(n: number): boolean {
  return Number.isSafeInteger(n) && n >= 0;
}

/** A valid range has non-negative integer coordinates and start <= end. Empty ranges are allowed. */
export function sourceRange(
  startLine: number,
  startCol: number,
  endLine: number,
  endCol: number,
): Result<SourceRange, DomainError> {
  const coords = { startLine, startCol, endLine, endCol };
  if (![startLine, startCol, endLine, endCol].every(isNonNegativeInt)) {
    return err(domainError('INVALID_SOURCE_RANGE', 'range coordinates must be non-negative integers', coords));
  }
  if (startLine > endLine || (startLine === endLine && startCol > endCol)) {
    return err(domainError('INVALID_SOURCE_RANGE', 'range start must not be after range end', coords));
  }
  return ok(coords);
}
