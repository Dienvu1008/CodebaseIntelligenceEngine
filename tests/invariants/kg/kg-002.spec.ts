// KG-002: typed relations with defined semantics. Every relation type is in the RelationType registry
// (KNOWLEDGE_GRAPH_DESIGN §3), the (fromKind, toKind) of each relation matches the type's signature, and its
// status is one the type allows. Layers:
//  - domain: the registry is well formed and in sync with the design doc; relationViolations rejects each
//    kind of mismatch;
//  - compile time: every code edge type and edge status is registered (RegisteredCodeEdgeType);
//  - producers: every edge of every golden export satisfies the registry;
//  - store: the RevisionValidator aborts the publish of a stored edge that breaks it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  CODE_EDGE_TYPES,
  GRAPH_NODE_KINDS,
  KnowledgeClaim,
  OCCURRENCE_EDGE_TYPES,
  RELATION_STATUSES,
  RELATION_TYPES,
  relationType,
  relationViolations,
  type CodeGraph,
  type NodeId,
  type RegisteredCodeEdgeType,
  type RelationTypeName,
} from '@cie/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { code, CONCEPT, evidence, FN_A, FN_B, hasher, seq, SYSTEM, unwrap } from '../../helpers/claims.js';
import { codeGraphOf } from '../../helpers/code-graph.js';
import { GOLDEN_FIXTURES } from '../../helpers/golden.js';
import { cseq, job, publishRevision, sandbox, stageAll, type Sandbox } from '../../helpers/index-store.js';
import { REPO_ROOT as root } from '../../helpers/repo.js';

describe('KG-002: the registry', () => {
  it('is well formed: unique names, known kinds and statuses, no duplicate signatures', () => {
    const names = RELATION_TYPES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of RELATION_TYPES) {
      expect(t.signatures.length, t.name).toBeGreaterThan(0);
      expect(t.allowedStatuses.length, t.name).toBeGreaterThan(0);
      for (const s of t.signatures) {
        expect(GRAPH_NODE_KINDS, `${t.name} from`).toContain(s.from);
        expect(GRAPH_NODE_KINDS, `${t.name} to`).toContain(s.to);
      }
      const keys = t.signatures.map((s) => `${s.from}->${s.to}`);
      expect(new Set(keys).size, t.name).toBe(keys.length);
      for (const s of t.allowedStatuses) expect(RELATION_STATUSES).toContain(s);
      expect(Object.isFrozen(t) && Object.isFrozen(t.signatures)).toBe(true);
    }
  });

  it('lists exactly the types of KNOWLEDGE_GRAPH_DESIGN §3, in order', () => {
    const doc = readFileSync(path.join(root, 'docs/planning/KNOWLEDGE_GRAPH_DESIGN.md'), 'utf8');
    const section = doc.slice(doc.indexOf('## 3. Relation types'), doc.indexOf('**Distinguishing'));
    const documented = [...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(documented).toEqual(RELATION_TYPES.map((t) => t.name));
  });

  it('registers every code edge type, introduced no later than the current phase (also checked at compile time)', () => {
    const registered: readonly RegisteredCodeEdgeType[] = CODE_EDGE_TYPES;
    for (const name of registered) expect(relationType(name)?.since, name).toBeLessThanOrEqual(3);
    // Occurrence-based types are the ones identified per site (KNOWLEDGE_GRAPH_DESIGN §4): calls only;
    // references are one edge per (from, to) with an occurrence count (P03-07).
    expect(RELATION_TYPES.filter((t) => t.occurrence).map((t) => t.name)).toEqual<RelationTypeName[]>(['calls']);
    expect(RELATION_TYPES.filter((t) => t.occurrence).map((t) => t.name)).toEqual([...OCCURRENCE_EDGE_TYPES]);
  });

  it('rejects unregistered types, signature mismatches, disallowed statuses and wrong site keys', () => {
    const ok = { type: 'imports', fromKind: 'module', toKind: 'external', status: 'verified', site: '' };
    expect(relationViolations(ok)).toEqual([]);
    expect(relationViolations({ ...ok, type: 'uses' })).toEqual([expect.stringContaining('"uses" is not registered')]);
    expect(relationViolations({ ...ok, toKind: 'symbol' })).toEqual([expect.stringContaining('does not connect module -> symbol')]);
    expect(relationViolations({ ...ok, fromKind: 'symbol' })).toEqual([expect.stringContaining('does not connect symbol -> external')]);
    expect(relationViolations({ ...ok, status: 'user_asserted' })).toEqual([expect.stringContaining('status user_asserted is not allowed for imports')]);
    expect(relationViolations({ ...ok, site: 'abc' })).toEqual([expect.stringContaining('has no site key')]);
    const call = { type: 'calls', fromKind: 'symbol', toKind: 'unresolved', status: 'unknown' };
    expect(relationViolations({ ...call, site: 'h1' })).toEqual([]);
    expect(relationViolations({ ...call, site: '' })).toEqual([expect.stringContaining('needs a site key')]);
    expect(relationViolations({ ...call, type: 'references' })).toHaveLength(2); // no unresolved target, no unknown status
    expect(relationViolations({ type: 'mentions', fromKind: 'page', toKind: 'unresolved', status: 'verified' })).toEqual([]);
  });
});

describe('KG-002: claims', () => {
  const base = { origin: { kind: 'heuristic' as const, id: 'h' }, evidence: [evidence('heuristic')], actor: SYSTEM, reason: 'r', seq: seq(1) };
  it('rejects a claim whose predicate signature or status does not fit the registry', () => {
    expect(code(KnowledgeClaim.propose({ ...base, subject: FN_A, predicate: 'calls', object: FN_B, status: 'inferred' }, hasher))).toBe('ok');
    expect(code(KnowledgeClaim.propose({ ...base, subject: CONCEPT, predicate: 'calls', object: FN_B, status: 'inferred' }, hasher))).toBe('KG_002_CLAIM_INVALID');
    // injects allows only inferred
    expect(code(KnowledgeClaim.propose({ ...base, subject: FN_A, predicate: 'injects', object: FN_B, status: 'unknown', evidence: [] }, hasher))).toBe('KG_002_CLAIM_INVALID');
    // implements allows only verified: an inferred proposal is refused, and verification is the only way in
    expect(code(KnowledgeClaim.propose({ ...base, subject: FN_A, predicate: 'implements', object: FN_B, status: 'inferred' }, hasher))).toBe('KG_002_CLAIM_INVALID');
  });

  it('re-checks the registry on every transition', () => {
    // may_dispatch_to allows only inferred: dropping to unknown is refused by the registry, not the table.
    const c = unwrap(KnowledgeClaim.propose({ ...base, subject: FN_A, predicate: 'may_dispatch_to', object: FN_B, status: 'inferred' }, hasher));
    expect(code(c.transition('unknown', SYSTEM, 'evidence gone', seq(2)))).toBe('KG_002_CLAIM_INVALID');
  });
});

describe('KG-002: producers', () => {
  it.each(GOLDEN_FIXTURES)('every edge of the %s golden export satisfies the registry', (name) => {
    const exp = JSON.parse(readFileSync(path.join(root, 'fixtures', `${name}.export.json`), 'utf8')) as {
      nodes: { id: string; kind: string }[];
      structure: { id: string; kind: string }[];
      edges: { type: string; from: string; to: string; status: string; site: string }[];
    };
    const kinds = new Map([...exp.structure, ...exp.nodes].map((n) => [n.id, n.kind]));
    const violations = exp.edges.flatMap((e) =>
      relationViolations({ type: e.type, fromKind: kinds.get(e.from) ?? '?', toKind: kinds.get(e.to) ?? '?', status: e.status, site: e.site }, `${e.type} ${e.from} -> ${e.to}`),
    );
    expect(violations).toEqual([]);
  });
});

describe('KG-002: the relation_type table (P03-09)', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox();
  });
  afterEach(() => sb.dispose());

  it('seeds one row per registry type, and edge.type is a foreign key to it', async () => {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    await publishRevision(o, [], 0);
    const db = new Database(path.join(sb.stateDir, 'index.db'), { readonly: true });
    try {
      const rows = db.prepare('select name, occurrence, since from relation_type order by name').all() as Array<{ name: string; occurrence: number; since: number }>;
      expect(rows.map((r) => r.name).sort()).toEqual(RELATION_TYPES.map((t) => t.name).sort());
      const calls = rows.find((r) => r.name === 'calls');
      expect([calls?.occurrence, calls?.since]).toEqual([1, 3]);
      // The edge FK: a type absent from relation_type cannot be stored (DB layer of KG-002).
      const fks = db.pragma('foreign_key_list(edge)') as Array<{ table: string; from: string }>;
      expect(fks.some((f) => f.table === 'relation_type' && f.from === 'type')).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe('KG-002: the RevisionValidator', () => {
  let sb: Sandbox;
  beforeEach(async () => {
    sb = await sandbox();
  });
  afterEach(() => sb.dispose());

  const FILES = {
    'src/a.ts': "import { b } from './b';\nimport fs from 'node:fs';\nexport function a() { return b }\n",
    'src/b.ts': 'export const b = 1;\nexport class B { m() {} }\n',
  };

  async function attempt(change: (g: CodeGraph) => CodeGraph): Promise<{ violations: readonly string[]; code: string | null }> {
    const o = await sb.open();
    await o.store.lease.acquire('writer-1', 60_000);
    const { manifest, graph } = await codeGraphOf(FILES);
    const rev = await o.store.begin(null, job('j1'));
    if (!rev.ok) throw new Error(rev.error.code);
    await stageAll(o, rev.value.seq, manifest, change(graph));
    await o.store.markValidating(rev.value.seq);
    const violations = (await o.store.validate(rev.value.seq)).filter((v) => v.startsWith('KG-002:'));
    const published = await o.store.publish(rev.value.seq, cseq(0));
    return { violations, code: published.ok ? null : published.error.code };
  }

  const edit = (g: CodeGraph, pick: (e: CodeGraph['edges'][number]) => boolean, change: (e: CodeGraph['edges'][number]) => CodeGraph['edges'][number]): CodeGraph => {
    if (!g.edges.some(pick)) throw new Error('no such edge');
    return { ...g, edges: g.edges.map((e) => (pick(e) ? change(e) : e)) };
  };

  it('publishes a graph whose edges all satisfy the registry', async () => {
    expect(await attempt((g) => g)).toEqual({ violations: [], code: null });
  });

  it('aborts the publish of an edge with a status its type does not allow', async () => {
    const r = await attempt((g) => edit(g, (e) => e.type === 'defines', (e) => ({ ...e, status: 'inferred' })));
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.every((v) => v.includes('status inferred is not allowed for defines'))).toBe(true);
    expect(r.code).toBe('PUBLISH_VALIDATION_FAILED');
  });

  it('aborts the publish of an edge whose endpoint kinds do not match the signature', async () => {
    // An imports edge retargeted from a module to a symbol (both endpoints exist, so KG-001 holds).
    const r = await attempt((g) => edit(g, (e) => e.type === 'imports' && e.to === 'mod:ts:src/b.ts', (e) => ({ ...e, to: 'ts:src/b.ts#B(class)' as NodeId })));
    expect(r.violations).toEqual(['KG-002: imports mod:ts:src/a.ts -> ts:src/b.ts#B(class): imports does not connect module -> symbol']);
    expect(r.code).toBe('PUBLISH_VALIDATION_FAILED');
  });

  it('aborts the publish of a non-occurrence edge that carries a site key', async () => {
    const r = await attempt((g) => edit(g, (e) => e.type === 'exports', (e) => ({ ...e, site: 'h1' })));
    expect(r.violations.length).toBeGreaterThan(0);
    expect(r.violations.every((v) => v.endsWith('exports has no site key'))).toBe(true);
    expect(r.code).toBe('PUBLISH_VALIDATION_FAILED');
  });
});
