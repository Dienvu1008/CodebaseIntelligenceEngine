// Builders for knowledge-context tests: evidence, claims in every status, and revision views.
import { NodeHasher } from '@cie/adapters';
import {
  canonicalizePath,
  createEvidence,
  KnowledgeClaim,
  producerIdentity,
  revisionSeq,
  type CanonicalPath,
  type ClaimActor,
  type ContentHash,
  type Evidence,
  type EvidenceInput,
  type EvidenceKind,
  type EvidenceLocator,
  type NodeId,
  type RevisionSeq,
  type RevisionView,
} from '@cie/core';
import { ClaimVerifier } from '@cie/core/verification';

export const hasher = new NodeHasher();

export function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}
export const code = (r: { ok: boolean; error?: { code: string } }): string => (r.ok ? 'ok' : (r.error?.code ?? '?'));

export const seq = (n: number): RevisionSeq => unwrap(revisionSeq(n));
export const path = (p: string): CanonicalPath => unwrap(canonicalizePath(p));
export const hash = (text: string): ContentHash => hasher.sha256Text(text);

export const SYSTEM: ClaimActor = { kind: 'system', id: 'cie' };
export const PRODUCER: ClaimActor = { kind: 'producer', id: 'lang-ts' };
export const LLM: ClaimActor = { kind: 'llm', id: 'ollama:qwen' };
export const USER: ClaimActor = { kind: 'user', id: 'alice' };

const PRODUCERS: Record<EvidenceKind, [string, string, string]> = {
  filesystem: ['workspace', '0.1.0', 'node@24'],
  ast: ['treesitter', '0.1.0', 'web-tree-sitter@0.27.1'],
  compiler: ['lang-ts', '0.1.0', 'typescript@6.0.3'],
  scip: ['scip', '0.1.0', 'scip-typescript@0.4.0'],
  lsp: ['lsp', '0.1.0', 'tsserver@6.0.3'],
  heuristic: ['lang-python', '0.1.0', 'heuristic@1'],
  llm: ['llm-ollama', '0.1.0', 'qwen2.5-coder@7b'],
  user: ['markdown', '0.1.0', 'remark@15'],
};

export const source = (p: string, line = 0): EvidenceLocator => ({ kind: 'source', path: path(p), range: { startLine: line, startCol: 0, endLine: line, endCol: 5 } });

/** Evidence of `kind`, observed at seq 1 in `src/a.ts` with content "v1" (or an llm artifact). */
export function evidence(kind: EvidenceKind, overrides: Partial<EvidenceInput> = {}): Evidence {
  const [id, version, tool] = PRODUCERS[kind];
  const locator: EvidenceLocator = kind === 'llm' ? { kind: 'artifact', artifact: `llm:response:${hash('answer').slice(7, 23)}` } : source('src/a.ts');
  return unwrap(createEvidence({ kind, producer: unwrap(producerIdentity(id, version, tool)), seq: seq(1), contentHash: hash('v1'), locator, ...overrides }, hasher));
}

/** A revision view at `at` in which every source file has content `contents[path]` (default "v1"); artifacts are immutable. */
export function view(at = 1, contents: Readonly<Record<string, string | null>> = {}): RevisionView {
  return {
    seq: seq(at),
    currentHash: (l) => {
      if (l.kind === 'artifact') return null;
      const c = l.path in contents ? contents[l.path] : 'v1';
      return c === null || c === undefined ? null : hash(c);
    },
  };
}

export const FN_A = { id: 'ts:src/a.ts#a(function)' as NodeId, kind: 'symbol' as const };
export const FN_B = { id: 'ts:src/b.ts#b(function)' as NodeId, kind: 'symbol' as const };
export const CONCEPT = { id: 'concept:session-refresh' as NodeId, kind: 'concept' as const };

export function proposed(status: 'unknown' | 'inferred', ev: readonly Evidence[] = status === 'inferred' ? [evidence('heuristic')] : [], actor: ClaimActor = SYSTEM): KnowledgeClaim {
  return unwrap(
    KnowledgeClaim.propose(
      { subject: FN_A, predicate: 'calls', object: FN_B, origin: { kind: 'heuristic', id: 'py-calls' }, status, evidence: ev, actor, reason: 'test', seq: seq(1) },
      hasher,
    ),
  );
}

export function verified(): KnowledgeClaim {
  return unwrap(ClaimVerifier.verify(proposed('inferred', [evidence('heuristic'), evidence('compiler')]), view(), PRODUCER, 'compiler confirms the call'));
}

export function userAsserted(): KnowledgeClaim {
  return unwrap(
    KnowledgeClaim.assertByUser(
      { subject: FN_A, predicate: 'implements_concept', object: CONCEPT, origin: { kind: 'page', id: 'page:auth' }, evidence: [evidence('user', { locator: { kind: 'artifact', artifact: 'page:auth#frontmatter' } })], actor: USER, reason: 'front matter', seq: seq(1) },
      hasher,
    ),
  );
}
