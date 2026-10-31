// Type-level fitness checks (ARCHITECTURE_FITNESS §5). The `@ts-expect-error` lines are verified by
// `npm run typecheck` (tsc -p tests): if an assignment ever becomes legal, typecheck fails.
import type { CancellationSignal, CanonicalPath, ContentHash, RevisionSeq, SymbolId, WorkspaceId } from '@cie/core';
import { parseContentHash, revisionSeq } from '@cie/core';
import { describe, expect, it } from 'vitest';

describe('branded identifiers', () => {
  it('cannot be created from raw primitives', () => {
    // @ts-expect-error a raw string is not a SymbolId (only SymbolIdentity may create one, SY-001)
    const symbol: SymbolId = 'ts:src/a.ts#a(function)';
    // @ts-expect-error a raw string is not a CanonicalPath (only PathCanonicalizer may create one, WS-002)
    const file: CanonicalPath = 'src/a.ts';
    // @ts-expect-error a raw string is not a ContentHash
    const hash: ContentHash = 'sha256:00';
    // @ts-expect-error a raw number is not a RevisionSeq
    const seq: RevisionSeq = 1;
    expect([symbol, file, hash, seq]).toHaveLength(4);
  });

  it('are not interchangeable with each other', () => {
    const result = revisionSeq(3);
    if (!result.ok) throw new Error('fixture');
    // @ts-expect-error a WorkspaceId is not a SymbolId
    const asSymbol: SymbolId = 'ws' as WorkspaceId;
    expect(asSymbol).toBe('ws');
  });

  it('are produced only through validating constructors', () => {
    const hash = parseContentHash(`sha256:${'a'.repeat(64)}`);
    expect(hash.ok).toBe(true);
  });
});

describe('CancellationSignal (contradiction log C-01)', () => {
  it('is structurally satisfied by a real AbortSignal', () => {
    const controller = new AbortController();
    const signal: CancellationSignal = controller.signal;
    let aborted = false;
    signal.addEventListener('abort', () => {
      aborted = true;
    }, { once: true });
    controller.abort('stop');
    expect(signal.aborted).toBe(true);
    expect(aborted).toBe(true);
  });
});
