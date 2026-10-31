/**
 * PythonImportResolver: deterministic heuristic import resolution for Python (CODE_INTELLIGENCE_STRATEGY §5,
 * §6.5). It declares imports at L2, so every resolved edge is `heuristic` / `inferred` (SY-006): the rules
 * follow the import system closely, but without running the interpreter (`sys.path`, `.pth` files,
 * installed distributions) they are not proven.
 *
 * Source roots, in this order for a given file: the detected roots that contain the file (deepest first),
 * then the other roots in path order. Detected roots:
 *  - the workspace root;
 *  - `src/` when it contains Python files (src layout);
 *  - every directory with `pyproject.toml`, `setup.py` or `setup.cfg`, plus its `src/` when that contains
 *    Python files.
 * Module lookup in a directory follows the FileFinder order: package (`x/__init__.py`, then `.pyi`) before
 * module (`x.py`, then `x.pyi`).
 *
 * Classification:
 *  - relative import (`.x`, `..`) → resolved inside the importing file's package; climbing above the
 *    workspace or a missing target → unresolved;
 *  - absolute import found under a source root → module;
 *  - otherwise a standard-library top-level name → `ext:python:<top>`;
 *  - otherwise a third-party top-level name → `ext:pypi:<top>` (the import name; distribution names
 *    can differ, for example `yaml` vs PyYAML);
 *  - a namespace package (a workspace directory without `__init__.py`) with no module file → unresolved;
 *  - non-literal `importlib.import_module(x)` / `__import__(x)` → unresolved.
 * `from X import n`: `n` is a submodule when `X/n.py` (or a package) exists, giving an extra `imports` edge.
 * Otherwise it is a name in X, giving an `imports_symbol` edge to the single top-level symbol `n` of X, or
 * unresolved if there are zero or several.
 */
import {
  capabilityProfile,
  createImportEdge,
  domainError,
  err,
  ok,
  producerIdentity,
  type CancellationSignal,
  type CanonicalPath,
  type CapabilityProfile,
  type DomainError,
  type ExtractedImport,
  type FileExtraction,
  type Hasher,
  type ImportResolution,
  type ImportTarget,
  type LanguageId,
  type ProducerIdentity,
  type ProjectDescriptor,
  type ProjectInput,
  type ProjectResolution,
  type ProjectResolver,
  type Result,
  type StructuralEdge,
} from '@cie/core';
import { NodeHasher } from '../fs/system.js';
import { PYTHON_STDLIB } from './stdlib.js';

export const LANG_PYTHON_ADAPTER_VERSION = '0.1.0';
const PY = 'py' as LanguageId;
const PROFILE = { symbols: 'L0', imports: 'L2', references: 'L0', calls: 'L0', typeRelations: 'L0', di: 'L0', docstrings: 'L0' };
const PROJECT_FILES = new Set(['pyproject.toml', 'setup.py', 'setup.cfg']);

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const join = (dir: string, rel: string): string => (dir === '' ? rel : rel === '' ? dir : `${dir}/${rel}`);
const isPython = (p: string): boolean => p.endsWith('.py') || p.endsWith('.pyi');
const within = (file: string, dir: string): boolean => dir === '' || file.startsWith(`${dir}/`);
const byPath = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

type Classified = { readonly target: ImportTarget; readonly precision: 'heuristic' | null };
const UNRESOLVED: Classified = { target: { kind: 'unresolved' }, precision: null };

class Layout {
  readonly roots: readonly string[];
  private readonly files: ReadonlySet<string>;
  private readonly dirs = new Set<string>();

  constructor(paths: readonly CanonicalPath[]) {
    this.files = new Set(paths);
    for (const p of paths) for (let d = dirName(p); d !== '' && !this.dirs.has(d); d = dirName(d)) this.dirs.add(d);
    const hasPythonUnder = (dir: string) => paths.some((p) => isPython(p) && p.startsWith(`${dir}/`));
    const roots = new Set<string>(['']);
    if (hasPythonUnder('src')) roots.add('src');
    for (const p of paths.filter((x) => PROJECT_FILES.has(baseName(x)))) {
      const d = dirName(p);
      roots.add(d);
      if (hasPythonUnder(join(d, 'src'))) roots.add(join(d, 'src'));
    }
    this.roots = [...roots].sort(byPath);
  }

  /** Roots in lookup order for `file`: containing roots deepest first, then the rest in path order. */
  rootsFor(file: string): readonly string[] {
    const containing = this.roots.filter((r) => within(file, r)).sort((a, b) => b.length - a.length);
    return [...containing, ...this.roots.filter((r) => !within(file, r))];
  }

  /** `dir/<dotted as path>` as a package or module file, in FileFinder order. */
  lookup(dir: string, dotted: string): CanonicalPath | null {
    const rel = dotted.split('.').join('/');
    const base = join(dir, rel);
    for (const c of [`${base}/__init__.py`, `${base}/__init__.pyi`, `${base}.py`, `${base}.pyi`]) if (this.files.has(c)) return c as CanonicalPath;
    return null;
  }

  /** True when `dotted` names a directory under some root: a namespace package (PEP 420) with no module file. */
  isNamespaceDir(dotted: string): boolean {
    const rel = dotted.split('.').join('/');
    return this.roots.some((r) => this.dirs.has(join(r, rel)));
  }

  /** `dir/__init__.py` (or `.pyi`), the module of the package `dir` itself. */
  packageInit(dir: string): CanonicalPath | null {
    for (const c of [join(dir, '__init__.py'), join(dir, '__init__.pyi')]) if (this.files.has(c)) return c as CanonicalPath;
    return null;
  }

  /** Package directory for a relative import of `level` dots from `file`, or null above the workspace. */
  static relativeBase(file: string, level: number): string | null {
    let dir = dirName(file);
    for (let i = 1; i < level; i++) {
      if (dir === '') return null;
      dir = dirName(dir);
    }
    return dir;
  }
}

const module = (path: CanonicalPath): Classified => ({ target: { kind: 'module', language: PY, path }, precision: 'heuristic' });

export class PythonImportResolver implements ProjectResolver {
  readonly profiles: readonly CapabilityProfile[];

  private constructor(
    readonly producer: ProducerIdentity,
    profile: CapabilityProfile,
    private readonly hasher: Hasher,
  ) {
    this.profiles = [profile];
  }

  static create(options: { readonly hasher?: Hasher } = {}): Result<PythonImportResolver, DomainError> {
    const producer = producerIdentity('lang-python', LANG_PYTHON_ADAPTER_VERSION, 'python-import-heuristics@1');
    if (!producer.ok) return producer;
    const profile = capabilityProfile(PY, PROFILE);
    if (!profile.ok) return profile;
    return ok(new PythonImportResolver(producer.value, profile.value, options.hasher ?? new NodeHasher()));
  }

  resolve(input: ProjectInput, signal: CancellationSignal): Promise<Result<ProjectResolution, DomainError>> {
    const layout = new Layout(input.manifest.map((e) => e.path));
    const byFile = new Map(input.extractions.map((x) => [x.path, x] as const));
    const edges: StructuralEdge[] = [];
    const diagnostics: ProjectResolution['diagnostics'][number][] = [];
    for (const extraction of [...input.extractions].sort((a, b) => byPath(a.path, b.path))) {
      if (extraction.language !== PY) continue;
      if (signal.aborted) return Promise.resolve(err(domainError('RESOLUTION_CANCELLED', 'resolution was cancelled')));
      for (const imp of extraction.imports) {
        for (const res of this.resolutions(layout, extraction, imp, byFile)) {
          const edge = createImportEdge(extraction, res, { producer: this.producer, profile: this.profiles[0] as CapabilityProfile }, this.hasher);
          if (edge.ok) edges.push(edge.value);
          else diagnostics.push({ code: edge.error.code, message: edge.error.message, range: imp.range, path: extraction.path });
        }
      }
    }
    const projects: ProjectDescriptor[] = layout.roots.map((r) => ({ kind: 'python-root', language: PY, config: null, root: r === '' ? null : (r as CanonicalPath) }));
    return Promise.resolve(ok({ edges, projects, diagnostics }));
  }

  private resolutions(layout: Layout, extraction: FileExtraction, imp: ExtractedImport, byFile: ReadonlyMap<CanonicalPath, FileExtraction>): ImportResolution[] {
    const c = this.classify(layout, extraction.path, imp);
    // `from . import x` inside a package's __init__ names the package itself: no self-edge.
    const self = c.target.kind === 'module' && c.target.path === extraction.path;
    const out: ImportResolution[] = self ? [] : [{ type: 'imports', importIndex: imp.index, name: null, target: c.target, precision: c.precision }];
    if (c.target.kind !== 'module' || imp.names.length === 0) return out;
    const pkgDir = baseName(c.target.path).startsWith('__init__.') ? dirName(c.target.path) : null;
    for (const name of imp.names) {
      const sub = pkgDir === null ? null : layout.lookup(pkgDir, name);
      if (sub !== null) {
        out.push({ type: 'imports', importIndex: imp.index, name: null, target: { kind: 'module', language: PY, path: sub }, precision: 'heuristic' });
        continue;
      }
      const candidates = (byFile.get(c.target.path)?.symbols ?? []).filter((s) => s.parent === null && s.name === name);
      const only = candidates.length === 1 ? candidates[0] : undefined;
      out.push(
        only === undefined
          ? { type: 'imports_symbol', importIndex: imp.index, name, target: { kind: 'unresolved' }, precision: null }
          : { type: 'imports_symbol', importIndex: imp.index, name, target: { kind: 'symbol', id: only.id }, precision: 'heuristic' },
      );
    }
    return out;
  }

  private classify(layout: Layout, file: CanonicalPath, imp: ExtractedImport): Classified {
    if (imp.specifier.kind === 'expression') return UNRESOLVED;
    const spec = imp.specifier.value;
    if (spec.startsWith('.')) {
      const level = /^\.+/.exec(spec)?.[0].length ?? 0;
      const base = Layout.relativeBase(file, level);
      const rest = spec.slice(level);
      if (base === null) return UNRESOLVED;
      const found = rest === '' ? layout.packageInit(base) : layout.lookup(base, rest);
      return found === null ? UNRESOLVED : module(found);
    }
    for (const root of layout.rootsFor(file)) {
      const found = layout.lookup(root, spec);
      if (found !== null) return module(found);
    }
    const top = spec.split('.')[0] ?? spec;
    // A workspace directory of that name (namespace package) means the import is local but has no module
    // file to point at; calling it third-party would be a guess.
    if (top === '' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(top) || layout.isNamespaceDir(top)) return UNRESOLVED;
    return { target: { kind: 'external', ecosystem: PYTHON_STDLIB.has(top) ? 'python' : 'pypi', name: top }, precision: 'heuristic' };
  }
}
