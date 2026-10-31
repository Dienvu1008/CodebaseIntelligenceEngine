/**
 * A TypeScript ParseConfigHost / ModuleResolutionHost over the workspace snapshot, never the real disk:
 *  - files and directories come from the manifest, so resolution sees exactly the indexed snapshot (WS-004);
 *  - contents are available only for configuration files read up front through the root-confined
 *    FileSystem port (tsconfig*.json, jsconfig*.json, package.json);
 *  - `node_modules` is ignored by default and is never read. Instead, `…/node_modules/<name>/…` is mapped onto
 *    the directory of the workspace package named `<name>`. That way monorepo imports, package `exports`
 *    and self-references resolve the way npm/yarn/pnpm workspaces link them, without touching installed
 *    packages.
 * Paths are virtual and POSIX-style: the workspace root is `/ws`, so `src/a.ts` is `/ws/src/a.ts`.
 */
import type { CanonicalPath } from '@cie/core';
import type ts from 'typescript';

/** The TypeScript module, loaded lazily by the resolver (it is large; most consumers never need it). */
export type TypeScript = typeof ts;

export const VIRTUAL_ROOT = '/ws';
const NM = '/node_modules/';

export const toVirtual = (p: CanonicalPath | ''): string => (p === '' ? VIRTUAL_ROOT : `${VIRTUAL_ROOT}/${p}`);

/** Canonical path of a virtual path inside the root, or null. */
export function fromVirtual(v: string): CanonicalPath | null {
  return v.startsWith(`${VIRTUAL_ROOT}/`) ? (v.slice(VIRTUAL_ROOT.length + 1) as CanonicalPath) : null;
}

const parentOf = (v: string): string => v.slice(0, v.lastIndexOf('/')) || '/';
const strip = (v: string): string => (v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v);

/** Internal TS helper used by `sys.readDirectory` for include/exclude globbing (pinned TS version; see ADR-0016). */
type MatchFiles = (
  path: string,
  extensions: readonly string[] | undefined,
  excludes: readonly string[] | undefined,
  includes: readonly string[] | undefined,
  useCaseSensitiveFileNames: boolean,
  currentDirectory: string,
  depth: number | undefined,
  getFileSystemEntries: (path: string) => { readonly files: readonly string[]; readonly directories: readonly string[] },
  realpath: (path: string) => string,
) => string[];

function matchFilesImpl(typescript: TypeScript): MatchFiles {
  const fn = (typescript as unknown as { matchFiles?: MatchFiles }).matchFiles;
  if (typeof fn !== 'function') throw new Error(`typescript@${typescript.version} no longer exposes matchFiles; lang-ts needs an update (ADR-0016)`);
  return fn;
}

export class VirtualWorkspace implements ts.ParseConfigHost, ts.ModuleResolutionHost {
  readonly useCaseSensitiveFileNames = true;
  private readonly files = new Set<string>();
  private readonly children = new Map<string, { files: Set<string>; dirs: Set<string> }>();
  private readonly packages = new Map<string, string>(); // package name -> virtual dir
  private readonly scopes = new Set<string>();
  private readonly matchFiles: MatchFiles;

  constructor(
    typescript: TypeScript,
    paths: Iterable<CanonicalPath>,
    private readonly contents: ReadonlyMap<string, string>,
  ) {
    this.matchFiles = matchFilesImpl(typescript);
    this.ensureDir(VIRTUAL_ROOT);
    const linked = new Set<string>();
    for (const p of paths) {
      const v = toVirtual(p);
      const dir = parentOf(v);
      this.files.add(v);
      this.entry(dir).files.add(v.slice(v.lastIndexOf('/') + 1));
      if (!linked.has(dir)) this.ensureDir(dir);
      linked.add(dir);
    }
  }

  /** Registers workspace packages (name → directory). The first registration of a name wins. */
  registerPackage(name: string, dir: CanonicalPath | ''): boolean {
    if (this.packages.has(name)) return false;
    this.packages.set(name, toVirtual(dir));
    if (name.startsWith('@')) this.scopes.add(name.slice(0, name.indexOf('/')));
    return true;
  }

  private entry(dir: string): { files: Set<string>; dirs: Set<string> } {
    let e = this.children.get(dir);
    if (e === undefined) {
      e = { files: new Set(), dirs: new Set() };
      this.children.set(dir, e);
    }
    return e;
  }

  /** Links `dir` and every ancestor up to the root (the sets make repeated links free). */
  private ensureDir(dir: string): void {
    this.entry(dir);
    for (let d = dir; d !== VIRTUAL_ROOT && d.startsWith(`${VIRTUAL_ROOT}/`); d = parentOf(d)) {
      this.entry(parentOf(d)).dirs.add(d.slice(d.lastIndexOf('/') + 1));
    }
  }

  /** Maps `…/node_modules/<pkg>/rest` onto the workspace package `<pkg>`, or returns null. */
  alias(v: string): string | null {
    const i = v.lastIndexOf(NM);
    if (i < 0) return null;
    const rest = v.slice(i + NM.length);
    const parts = rest.split('/');
    const nameLength = rest.startsWith('@') ? 2 : 1;
    const name = parts.slice(0, nameLength).join('/');
    const dir = this.packages.get(name);
    if (dir === undefined) return null;
    const sub = parts.slice(nameLength).join('/');
    return sub === '' ? dir : `${dir}/${sub}`;
  }

  private real(v: string): string {
    const s = strip(v);
    return this.alias(s) ?? s;
  }

  fileExists(v: string): boolean {
    return this.files.has(this.real(v));
  }

  directoryExists(v: string): boolean {
    const s = strip(v);
    if (this.children.has(this.real(s))) return true;
    // The node_modules folder itself, and a scope folder inside it, exist when some package lives there.
    if (s.endsWith('/node_modules')) return this.packages.size > 0;
    const i = s.lastIndexOf(NM);
    return i >= 0 && this.scopes.has(s.slice(i + NM.length));
  }

  readFile(v: string): string | undefined {
    return this.contents.get(this.real(v));
  }

  realpath(v: string): string {
    return this.real(v);
  }

  getCurrentDirectory(): string {
    return VIRTUAL_ROOT;
  }

  getDirectories(v: string): string[] {
    return [...(this.children.get(this.real(v))?.dirs ?? [])].sort();
  }

  readDirectory(rootDir: string, extensions: readonly string[], excludes: readonly string[] | undefined, includes: readonly string[], depth?: number): string[] {
    const entries = (path: string) => {
      const e = this.children.get(strip(path));
      return { files: [...(e?.files ?? [])].sort(), directories: [...(e?.dirs ?? [])].sort() };
    };
    return this.matchFiles(rootDir, extensions, excludes, includes, true, VIRTUAL_ROOT, depth, entries, (p) => p);
  }
}
