/**
 * Structural nodes derived from the file manifest (FR-006): directories, npm packages (package.json),
 * Python packages (__init__.py) and TypeScript projects (tsconfig*.json). This is pure derivation, so the
 * same manifest always gives the same nodes, sorted by id (WS-004).
 *
 * Node ids are location-based (`pkg:npm:<dir>` rather than `pkg:npm:<name>`) so that two packages with the
 * same name in a monorepo never collide (a deviation from KNOWLEDGE_GRAPH_DESIGN §2, recorded in the
 * Phase 01 sign-off). Reading package names needs JSON parsing of file contents, which arrives in Phase 02.
 */
import type { CanonicalPath, NodeId } from '../../shared-kernel/index.js';
import type { ManifestEntry } from './manifest.js';

export type StructuralKind = 'directory' | 'package' | 'project';
export type Ecosystem = 'npm' | 'python' | 'typescript';

export interface StructuralNode {
  readonly id: NodeId;
  readonly kind: StructuralKind;
  /** Display name: last path segment of the directory (or "." for the root). */
  readonly name: string;
  readonly ecosystem: Ecosystem | null;
  /** The manifest file that backs the node (WS-001), or null for plain directories. */
  readonly file: CanonicalPath | null;
}

const dirOf = (p: string): string => {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i);
};
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const displayName = (dir: string): string => (dir === '' ? '.' : baseName(dir));
const idPart = (dir: string): string => (dir === '' ? '.' : dir);

function packageNode(e: ManifestEntry): StructuralNode | null {
  if (e.status !== 'indexed') return null;
  const name = baseName(e.path);
  const dir = dirOf(e.path);
  if (name === 'package.json') {
    return { id: `pkg:npm:${idPart(dir)}` as NodeId, kind: 'package', name: displayName(dir), ecosystem: 'npm', file: e.path };
  }
  if (name === '__init__.py') {
    return { id: `pkg:py:${idPart(dir)}` as NodeId, kind: 'package', name: displayName(dir), ecosystem: 'python', file: e.path };
  }
  if (/^tsconfig(\..+)?\.json$/.test(name)) {
    return { id: `proj:ts:${e.path}` as NodeId, kind: 'project', name, ecosystem: 'typescript', file: e.path };
  }
  return null;
}

export function deriveStructure(entries: readonly ManifestEntry[]): readonly StructuralNode[] {
  const nodes = new Map<string, StructuralNode>();
  for (const e of entries) {
    for (let dir = dirOf(e.path); dir !== ''; dir = dirOf(dir)) {
      const id = `dir:${dir}`;
      if (nodes.has(id)) break; // ancestors of a known directory are known too
      nodes.set(id, { id: id as NodeId, kind: 'directory', name: baseName(dir), ecosystem: null, file: null });
    }
    const pkg = packageNode(e);
    if (pkg !== null) nodes.set(pkg.id, pkg);
  }
  // UTF-16 code-unit order, like every other deterministic ordering in CIE (WS-004).
  return [...nodes.values()].sort((a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1));
}
