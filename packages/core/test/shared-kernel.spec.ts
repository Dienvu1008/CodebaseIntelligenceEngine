// Unit tests for the shared-kernel constructors (P00-06). They go through the public @cie/core entry point.
import { domainError, err, ok, parseContentHash, revisionSeq, sourceRange } from '@cie/core';
import { describe, expect, it } from 'vitest';

describe('revisionSeq', () => {
  it.each([0, 1, 42, Number.MAX_SAFE_INTEGER])('accepts %d', (n) => {
    expect(revisionSeq(n)).toEqual({ ok: true, value: n });
  });
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])('rejects %d', (n) => {
    const r = revisionSeq(n);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_REVISION_SEQ');
  });
});

describe('parseContentHash', () => {
  const valid = `sha256:${'0123456789abcdef'.repeat(4)}`;
  it('accepts sha256:<64 lowercase hex>', () => {
    expect(parseContentHash(valid)).toEqual({ ok: true, value: valid });
  });
  it.each([
    valid.toUpperCase(),
    valid.slice(0, -1),
    `${valid}0`,
    `sha1:${'a'.repeat(40)}`,
    'a'.repeat(64),
    `sha256:${'g'.repeat(64)}`,
    '',
  ])('rejects %s', (s) => {
    const r = parseContentHash(s);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_CONTENT_HASH');
  });
});

describe('sourceRange', () => {
  it('accepts ordered ranges, including empty ones', () => {
    expect(sourceRange(1, 2, 3, 4)).toEqual({ ok: true, value: { startLine: 1, startCol: 2, endLine: 3, endCol: 4 } });
    expect(sourceRange(5, 3, 5, 3).ok).toBe(true);
  });
  it.each([
    [2, 0, 1, 0],
    [1, 5, 1, 4],
    [-1, 0, 0, 0],
    [0, 0.5, 1, 0],
  ])('rejects (%d,%d)-(%d,%d)', (a, b, c, d) => {
    const r = sourceRange(a, b, c, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('INVALID_SOURCE_RANGE');
  });
});

describe('Result and DomainError', () => {
  it('builds tagged results', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
    expect(err('x')).toEqual({ ok: false, error: 'x' });
  });
  it('omits details when none are given (exactOptionalPropertyTypes)', () => {
    expect(domainError('C', 'm')).toEqual({ code: 'C', message: 'm' });
    expect('details' in domainError('C', 'm')).toBe(false);
    expect(domainError('C', 'm', { a: 1 })).toEqual({ code: 'C', message: 'm', details: { a: 1 } });
  });
});
