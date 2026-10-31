// PV-003: evidence completeness. Every evidence item has a kind, a producer (id and version), a seq, a
// content hash and a locator: a workspace path (with an optional range) or an artifact reference such as
// `scip:index.scip#…` or `llm:response:<hash>`. Evidence exists only through createEvidence (type level:
// every field is required), and its id is derived from what was observed.
import { createEvidence, EVIDENCE_KINDS, producerIdentity, type EvidenceInput } from '@cie/core';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { code, evidence, hash, hasher, path, seq, source, unwrap } from '../../helpers/claims.js';

const base: EvidenceInput = {
  kind: 'compiler',
  producer: unwrap(producerIdentity('lang-ts', '0.1.0', 'typescript@6.0.3')),
  seq: seq(3),
  contentHash: hash('v1'),
  locator: source('src/a.ts'),
};
const make = (o: Partial<EvidenceInput>) => createEvidence({ ...base, ...o }, hasher);

describe('PV-003: complete evidence is accepted', () => {
  it('records every field, frozen, for a source locator with and without a range and for artifacts', () => {
    const e = unwrap(make({}));
    expect(e).toMatchObject({ kind: 'compiler', seq: 3, contentHash: hash('v1'), producer: { adapterId: 'lang-ts', adapterVersion: '0.1.0', toolVersion: 'typescript@6.0.3' } });
    expect(e.id).toMatch(/^ev:[0-9a-f]{32}$/);
    expect(Object.isFrozen(e)).toBe(true);
    expect(code(make({ locator: { kind: 'source', path: path('src/a.ts'), range: null } }))).toBe('ok');
    expect(code(make({ kind: 'scip', locator: { kind: 'artifact', artifact: 'scip:index.scip#42' } }))).toBe('ok');
    for (const kind of EVIDENCE_KINDS) expect(evidence(kind).kind).toBe(kind);
  });

  it('copies its inputs, so later mutation of the input cannot change the evidence', () => {
    const range = { startLine: 1, startCol: 0, endLine: 2, endCol: 0 };
    const e = unwrap(make({ locator: { kind: 'source', path: path('src/a.ts'), range } }));
    range.endLine = 9;
    expect(e.locator).toEqual({ kind: 'source', path: 'src/a.ts', range: { startLine: 1, startCol: 0, endLine: 2, endCol: 0 } });
  });
});

describe('PV-003: incomplete or malformed evidence is rejected', () => {
  it.each([
    ['an unknown kind', { kind: 'guess' as never }, 'PV_003_KIND_INVALID'],
    ['a producer without id', { producer: { adapterId: '', adapterVersion: '0.1.0', toolVersion: 'x' } }, 'PV_003_PRODUCER_MISSING'],
    ['a producer without version', { producer: { adapterId: 'lang-ts', adapterVersion: '', toolVersion: 'x' } }, 'PV_003_PRODUCER_MISSING'],
    ['an artifact without scheme', { locator: { kind: 'artifact' as const, artifact: 'index.scip' } }, 'PV_003_LOCATOR_INVALID'],
    ['an artifact with whitespace', { locator: { kind: 'artifact' as const, artifact: 'scip:a b' } }, 'PV_003_LOCATOR_INVALID'],
    ['an inverted range', { locator: { kind: 'source' as const, path: path('src/a.ts'), range: { startLine: 3, startCol: 0, endLine: 1, endCol: 0 } } }, 'PV_003_LOCATOR_INVALID'],
    ['llm evidence pointing at source (AI-001)', { kind: 'llm' as const, locator: source('src/a.ts') }, 'PV_003_LOCATOR_INVALID'],
    ['llm evidence with a non-llm artifact', { kind: 'llm' as const, locator: { kind: 'artifact' as const, artifact: 'scip:index.scip#1' } }, 'PV_003_LOCATOR_INVALID'],
  ])('rejects %s', (_label, override, expected) => {
    expect(code(make(override))).toBe(expected);
  });

  it('cannot be built without every field (type level)', () => {
    // @ts-expect-error a locator is required
    const noLocator: EvidenceInput = { kind: 'ast', producer: base.producer, seq: seq(1), contentHash: hash('v') };
    // @ts-expect-error a content hash is required
    const noHash: EvidenceInput = { kind: 'ast', producer: base.producer, seq: seq(1), locator: source('a.ts') };
    // @ts-expect-error a seq is required
    const noSeq: EvidenceInput = { kind: 'ast', producer: base.producer, contentHash: hash('v'), locator: source('a.ts') };
    expect([noLocator, noHash, noSeq]).toHaveLength(3);
  });
});

describe('PV-003: evidence identity', () => {
  it('is ev:<hash(kind, producer, locator, contentHash)>: equal observations share an id, any difference changes it', () => {
    const id = unwrap(make({})).id;
    expect(unwrap(make({})).id).toBe(id);
    expect(unwrap(make({ seq: seq(9) })).id).toBe(id); // the seq is when, not what: not part of the identity
    const variants = [
      make({ kind: 'lsp' }),
      make({ producer: unwrap(producerIdentity('lang-ts', '0.2.0', 'typescript@6.0.3')) }),
      make({ contentHash: hash('v2') }),
      make({ locator: source('src/a.ts', 1) }),
      make({ locator: source('src/b.ts') }),
      make({ locator: { kind: 'source', path: path('src/a.ts'), range: null } }),
    ].map((r) => unwrap(r).id);
    expect(new Set([id, ...variants]).size).toBe(variants.length + 1);
  });

  it('never collides across generated locators (property-based)', () => {
    const loc = fc.record({ file: fc.constantFrom('a.ts', 'b.ts', 'src/a.ts'), line: fc.nat(5), col: fc.nat(5) });
    fc.assert(
      fc.property(loc, loc, (x, y) => {
        const a = unwrap(make({ locator: { kind: 'source', path: path(x.file), range: { startLine: x.line, startCol: x.col, endLine: x.line + 1, endCol: 0 } } }));
        const b = unwrap(make({ locator: { kind: 'source', path: path(y.file), range: { startLine: y.line, startCol: y.col, endLine: y.line + 1, endCol: 0 } } }));
        expect(a.id === b.id).toBe(x.file === y.file && x.line === y.line && x.col === y.col);
      }),
      { numRuns: 200 },
    );
  });
});
