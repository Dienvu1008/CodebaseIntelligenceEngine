// Code graphs for store-level invariant tests: real extraction and resolution of an in-memory workspace,
// projected with projectCodeGraph, ready for publishRevision(o, manifest, 0, graph).
import { LangTsResolver, PythonImportResolver } from '@cie/adapters';
import { projectCodeGraph, type CanonicalPath, type CodeGraph, type ManifestEntry } from '@cie/core';
import { resolveFixture } from './workspace-fixture.js';

const must = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const ts = must(LangTsResolver.create());
const py = must(PythonImportResolver.create());

export async function codeGraphOf(files: Readonly<Record<string, string>>): Promise<{ manifest: readonly ManifestEntry[]; graph: CodeGraph }> {
  const a = await resolveFixture(files, ts);
  const b = await resolveFixture(files, py);
  const indexed = new Set<CanonicalPath>(a.manifest.map((e) => e.path));
  return { manifest: a.manifest, graph: projectCodeGraph(a.extractions, [...a.resolution.edges, ...b.resolution.edges], indexed) };
}

/** Every edge endpoint is a node of the same graph (KG-001 over a read-back revision). */
export function danglingEdges(g: { nodes: readonly { id: string }[]; edges: readonly { type: string; from: string; to: string }[] }): string[] {
  const ids = new Set(g.nodes.map((n) => n.id));
  // Structural nodes (dir:, pkg:, proj:) live in structureAt; Phase 02 code edges never point at them.
  return g.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to)).map((e) => `${e.type} ${e.from} -> ${e.to}`);
}
