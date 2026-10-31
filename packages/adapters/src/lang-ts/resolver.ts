/**
 * LangTsResolver: the TS/TSX/JS ProjectResolver (ADR-0016, CODE_INTELLIGENCE_STRATEGY §6.4/§6.6).
 * Phase 02 scope is import resolution only (`paths`, `baseUrl`, package `exports`, project references
 * through tsconfig parsing). It uses `ts.resolveModuleName` over a VirtualWorkspace built from the snapshot,
 * so the result depends on the snapshot only and the real disk is never read. No Program or language service
 * is created, so no compiler or tsserver plugin can be loaded (A-06).
 *
 * Each literal import is classified as follows (precision per SY-006; lang-ts declares imports L3):
 *  - it resolves to a workspace file in an MVP language → `imports` edge to that module, exact;
 *  - it resolves to another workspace file (.json, .css, …) → no edge, diagnostic IMPORT_TARGET_NOT_A_MODULE;
 *  - a Node built-in (`node:*`, or a bare built-in name) → `ext:node:<name>`, exact;
 *  - a bare package that is not a workspace package and is not covered by `paths` → `ext:npm:<pkg>`: exact
 *    when an enclosing package.json declares it, heuristic otherwise (installed packages are never read);
 *  - anything else (missing relative file, unmatched `paths` target, broken workspace package) → unresolved.
 * Non-literal specifiers always go to unresolved.
 *
 * Named bindings of module imports become `imports_symbol` edges (Phase 03, P03-01/P03-03): a Program per project
 * (program.ts) and its TypeChecker follow each bound name through re-exports, barrels and CommonJS `require`
 * destructuring to its declaration, mapped to the extracted SymbolId: exact. A name tsc cannot find is unresolved.
 * Only when a file is not in a Program (it changed since enumeration or cannot be decoded) does the Phase 02
 * heuristic apply: the single exported top-level symbol of that name, recorded as heuristic.
 */
import {
  capabilityProfile,
  createImportEdge,
  domainError,
  encodeNameSegment,
  err,
  languageForPath,
  ok,
  producerIdentity,
  SourceText,
  type SymbolId,
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
  type ManifestEntry,
  type ProducerIdentity,
  type ProjectDescriptor,
  type ProjectInput,
  type ProjectResolution,
  type ProjectResolver,
  type Result,
  type StructuralEdge,
} from '@cie/core';
import { createRequire } from 'node:module';
import type ts from 'typescript';
import { NodeHasher } from '../fs/system.js';
import { bindingsAt, siteAt } from './bindings.js';
import { builtinName, packageNameOf } from './builtins.js';
import { decodeSourceText } from './decode.js';
import { buildProgram } from './program.js';
import { discoverProjects, type ProjectDiagnostic, type TsProject } from './projects.js';
import { fromVirtual, toVirtual, VirtualWorkspace, type TypeScript } from './virtual-host.js';

/**
 * The compiler is ~9 MB of JavaScript: it is loaded on the first resolution that needs it, never at import
 * time, so consumers of @cie/adapters that do not resolve TypeScript (stores, followers) do not pay for it.
 * The version comes from its package.json, which is cheap to read.
 */
const TYPESCRIPT_VERSION = (createRequire(import.meta.url)('typescript/package.json') as { version: string }).version;
let typescriptModule: Promise<TypeScript> | undefined;
const loadTypeScript = (): Promise<TypeScript> => (typescriptModule ??= import('typescript').then((m) => m.default));

export const LANG_TS_ADAPTER_VERSION = '0.1.0';
const LANGUAGES: readonly LanguageId[] = ['ts', 'tsx', 'js'];
const PROFILE = { symbols: 'L0', imports: 'L3', references: 'L0', calls: 'L0', typeRelations: 'L0', di: 'L0', docstrings: 'L0' };
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isConfigFile = (p: CanonicalPath): boolean => baseName(p) === 'package.json' || /^(ts|js)config(\..+)?\.json$/.test(baseName(p));

interface PackageInfo {
  readonly name: string | null;
  readonly dependencies: ReadonlySet<string>;
}

function parsePackage(text: string): PackageInfo {
  try {
    const json = JSON.parse(text) as Record<string, unknown>;
    const deps = new Set<string>();
    for (const f of DEPENDENCY_FIELDS) {
      const v = json[f];
      if (typeof v === 'object' && v !== null) for (const k of Object.keys(v)) deps.add(k);
    }
    return { name: typeof json['name'] === 'string' ? json['name'] : null, dependencies: deps };
  } catch {
    return { name: null, dependencies: new Set() };
  }
}

/** True when a `paths` pattern (at most one `*`) matches the specifier. */
function pathsCover(options: ts.CompilerOptions, specifier: string): boolean {
  return Object.keys(options.paths ?? {}).some((pattern) => {
    const star = pattern.indexOf('*');
    if (star < 0) return pattern === specifier;
    return specifier.length >= pattern.length - 1 && specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
  });
}

/** Everything resolution needs, built once per `resolve` call. */
class Session {
  readonly diagnostics: ProjectDiagnostic[] = [];
  readonly host: VirtualWorkspace;
  readonly manifest: ReadonlySet<CanonicalPath>;
  private readonly packages = new Map<string, PackageInfo>(); // dir -> info
  private readonly workspacePackages = new Set<string>();
  private readonly projects;

  constructor(
    readonly ts: TypeScript,
    entries: readonly ManifestEntry[],
    contents: ReadonlyMap<string, string>,
  ) {
    const paths = entries.map((e) => e.path);
    this.manifest = new Set(paths);
    this.host = new VirtualWorkspace(ts, paths, contents);
    for (const p of paths.filter((x) => baseName(x) === 'package.json')) {
      const info = parsePackage(contents.get(toVirtual(p)) ?? '');
      this.packages.set(dirName(p), info);
      if (info.name === null) continue;
      if (this.host.registerPackage(info.name, dirName(p) as CanonicalPath | '')) this.workspacePackages.add(info.name);
      else this.diagnostics.push({ code: 'DUPLICATE_PACKAGE_NAME', message: `package name "${info.name}" is used by several workspace packages; the first by path wins`, range: null, path: p });
    }
    this.projects = discoverProjects(ts, paths, this.host, this.diagnostics);
  }

  projectOf(file: CanonicalPath): TsProject {
    return this.projects.projectOf(file);
  }

  descriptors(used: ReadonlySet<TsProject>): ProjectDescriptor[] {
    const out: ProjectDescriptor[] = this.projects.projects.map((p) => ({ kind: 'tsconfig', language: 'ts', config: p.config, root: (dirName(p.config ?? '') || null) as CanonicalPath | null }));
    if (used.has(this.projects.inferred)) out.push({ kind: 'inferred', language: 'ts', config: null, root: null });
    return out;
  }

  isWorkspacePackage(name: string): boolean {
    return this.workspacePackages.has(name);
  }

  /** True when a package.json enclosing `file` (up to the root) declares `pkg` as a dependency. */
  declares(file: CanonicalPath, pkg: string): boolean {
    for (let dir = dirName(file); ; dir = dirName(dir)) {
      if (this.packages.get(dir)?.dependencies.has(pkg) === true) return true;
      if (dir === '') return false;
    }
  }
}

type Classified = { readonly target: ImportTarget; readonly precision: 'exact' | 'heuristic' | null } | { readonly skip: string };

interface Binding {
  readonly checker: ts.TypeChecker;
  readonly sf: ts.SourceFile;
}

interface ResolveContext {
  readonly session: Session;
  readonly byPath: ReadonlyMap<CanonicalPath, FileExtraction>;
  /** Decoded texts of the files in Programs (the same text the extractor parsed). */
  readonly texts: ReadonlyMap<CanonicalPath, string>;
}

const byPathOrder = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** tsconfig/jsconfig/package.json contents (virtual path → text), read through the FileSystem port. */
async function readConfigs(input: ProjectInput, signal: CancellationSignal): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const e of input.manifest) {
    if (e.status !== 'indexed' || !isConfigFile(e.path)) continue;
    const bytes = await input.fs.readFile(e.path, signal);
    if (bytes.ok) contents.set(toVirtual(e.path), new TextDecoder().decode(bytes.value));
  }
  return contents;
}

/**
 * The extracted SymbolId of a tsc declaration: the innermost extracted symbol of the declaring file whose range
 * contains the declaration's name (or, for unnamed declarations such as `export default class {}`, its last
 * character), with the same name. Null when the declaration is outside the workspace or was not extracted.
 */
function symbolOfDeclaration(ctx: ResolveContext, decl: ts.Declaration): SymbolId | null {
  const file = fromVirtual(decl.getSourceFile().fileName);
  const extraction = file === null ? undefined : ctx.byPath.get(file);
  const text = file === null ? undefined : ctx.texts.get(file);
  if (extraction === undefined || text === undefined) return null;
  const { point, name } = declarationAnchor(ctx.session.ts, decl);
  return innermostSymbol(extraction, new SourceText(text), point, name);
}

/** The module target of a workspace source file in an MVP language, or null (outside the workspace, other language). */
function moduleOfSourceFile(ctx: ResolveContext, sf: ts.SourceFile): ImportTarget | null {
  const path = fromVirtual(sf.fileName);
  if (path === null || !ctx.session.manifest.has(path)) return null;
  const language = languageForPath(path);
  return language === null ? null : { kind: 'module', language: language as LanguageId, path };
}

/** Where to look for the extracted symbol of a declaration, and the encoded name it must have (if named). */
function declarationAnchor(typescript: TypeScript, decl: ts.Declaration): { point: number; name: string | null } {
  const nameNode = typescript.getNameOfDeclaration(decl);
  if (nameNode === undefined) return { point: decl.getEnd() - 1, name: null };
  const named = typescript.isIdentifier(nameNode) || typescript.isPrivateIdentifier(nameNode) || typescript.isStringLiteral(nameNode);
  return { point: nameNode.getStart(), name: named ? encodeNameSegment(nameNode.text) : null };
}

/** The extracted symbol with the smallest range containing `point` (and named `name`, when given). */
function innermostSymbol(extraction: FileExtraction, source: SourceText, point: number, name: string | null): SymbolId | null {
  let best: { id: SymbolId; span: number } | null = null;
  for (const s of extraction.symbols) {
    if (name !== null && s.name !== name) continue;
    const start = source.offsetOf(s.range.startLine, s.range.startCol);
    const end = source.offsetOf(s.range.endLine, s.range.endCol);
    if (start === null || end === null || point < start || point >= end) continue;
    if (best === null || end - start < best.span) best = { id: s.id, span: end - start };
  }
  return best?.id ?? null;
}

export class LangTsResolver implements ProjectResolver {
  readonly profiles: readonly CapabilityProfile[];

  private constructor(
    readonly producer: ProducerIdentity,
    profiles: readonly CapabilityProfile[],
    private readonly hasher: Hasher,
  ) {
    this.profiles = profiles;
  }

  static create(options: { readonly hasher?: Hasher } = {}): Result<LangTsResolver, DomainError> {
    const producer = producerIdentity('lang-ts', LANG_TS_ADAPTER_VERSION, `typescript@${TYPESCRIPT_VERSION}`);
    if (!producer.ok) return producer;
    const profiles: CapabilityProfile[] = [];
    for (const l of LANGUAGES) {
      const p = capabilityProfile(l, PROFILE);
      if (!p.ok) return p;
      profiles.push(p.value);
    }
    return ok(new LangTsResolver(producer.value, profiles, options.hasher ?? new NodeHasher()));
  }

  async resolve(input: ProjectInput, signal: CancellationSignal): Promise<Result<ProjectResolution, DomainError>> {
    const own = input.extractions.filter((x) => LANGUAGES.includes(x.language));
    // Nothing to resolve: do not load the compiler at all.
    if (own.length === 0) return ok({ edges: [], projects: [], diagnostics: [] });
    const typescript = await loadTypeScript();
    const contents = await readConfigs(input, signal);
    const texts = await this.readSources(own, input, signal, contents);
    if (signal.aborted) return err(domainError('RESOLUTION_CANCELLED', 'resolution was cancelled'));

    const session = new Session(typescript, input.manifest, contents);
    const ctx: ResolveContext = { session, byPath: new Map(input.extractions.map((x) => [x.path, x] as const)), texts };
    const perFile = new Map<CanonicalPath, StructuralEdge[]>();
    const used = new Set<TsProject>();
    for (const [project, files] of this.groupByProject(session, own)) {
      if (signal.aborted) return err(domainError('RESOLUTION_CANCELLED', 'resolution was cancelled'));
      used.add(project);
      // One Program alive at a time (ADR-0016): built for this project, dropped after its files are resolved.
      const roots = files.filter((f) => texts.has(f.path)).map((f) => f.path);
      const program = roots.length === 0 ? null : buildProgram(typescript, session.host, roots, project.options);
      const checker = program?.getTypeChecker() ?? null;
      for (const extraction of files) {
        const sf = program?.getSourceFile(toVirtual(extraction.path));
        const binding = checker !== null && sf !== undefined ? { checker, sf } : null;
        perFile.set(extraction.path, extraction.imports.flatMap((imp) => this.edgesFor(ctx, project, extraction, imp, binding)));
      }
    }
    const edges = [...perFile.keys()].sort(byPathOrder).flatMap((p) => perFile.get(p) ?? []);
    return ok({ edges, projects: session.descriptors(used), diagnostics: session.diagnostics });
  }

  /**
   * Source texts of the files to resolve, read through the FileSystem port. A file whose bytes no longer hash to
   * its extraction (it changed since enumeration) or cannot be decoded is left out of the Program: its imports
   * fall back to the L1 heuristic binding.
   */
  private async readSources(own: readonly FileExtraction[], input: ProjectInput, signal: CancellationSignal, contents: Map<string, string>): Promise<Map<CanonicalPath, string>> {
    const texts = new Map<CanonicalPath, string>();
    for (const x of own) {
      if (signal.aborted) break;
      const bytes = await input.fs.readFile(x.path, signal);
      if (!bytes.ok || this.hasher.sha256(bytes.value) !== x.contentHash) continue;
      const text = decodeSourceText(bytes.value);
      if (text === null) continue;
      texts.set(x.path, text);
      contents.set(toVirtual(x.path), text);
    }
    return texts;
  }

  /** Extractions grouped by owning project: tsconfig projects in config path order, the inferred project last. */
  private groupByProject(session: Session, own: readonly FileExtraction[]): [TsProject, FileExtraction[]][] {
    const groups = new Map<TsProject, FileExtraction[]>();
    for (const x of [...own].sort((a, b) => byPathOrder(a.path, b.path))) {
      const p = session.projectOf(x.path);
      groups.set(p, [...(groups.get(p) ?? []), x]);
    }
    const key = (p: TsProject) => (p.config === null ? '\uffff' : p.config);
    return [...groups].sort(([a], [b]) => byPathOrder(key(a), key(b)));
  }

  private edgesFor(ctx: ResolveContext, project: TsProject, extraction: FileExtraction, imp: ExtractedImport, binding: Binding | null): StructuralEdge[] {
    const c = this.classify(ctx.session, project, extraction.path, imp);
    if ('skip' in c) {
      ctx.session.diagnostics.push({ code: c.skip, message: `import of ${JSON.stringify(imp.specifier)} not recorded (${c.skip})`, range: imp.range, path: extraction.path });
      return [];
    }
    const out: StructuralEdge[] = [];
    this.push(out, ctx.session, extraction, { type: 'imports', importIndex: imp.index, name: null, target: c.target, precision: c.precision });
    if (c.target.kind !== 'module') return out;
    const exact = binding === null ? null : this.exactBindings(ctx, extraction, imp, binding);
    for (const name of imp.names) {
      const res = exact === null ? this.heuristicBinding(ctx, c.target.path, imp, name) : this.exactBinding(ctx, imp, name, exact);
      this.push(out, ctx.session, extraction, res);
    }
    return out;
  }

  /** Bound names of an import site through the TypeChecker, or null when tsc has no node at the site. */
  private exactBindings(ctx: ResolveContext, extraction: FileExtraction, imp: ExtractedImport, binding: Binding): Map<string, ts.Declaration | null> | null {
    const text = ctx.texts.get(extraction.path);
    const offset = text === undefined ? null : new SourceText(text).offsetOf(imp.range.startLine, imp.range.startCol);
    const site = offset === null ? null : siteAt(ctx.session.ts, binding.sf, offset);
    return site === null ? null : bindingsAt(ctx.session.ts, binding.checker, site);
  }

  private exactBinding(ctx: ResolveContext, imp: ExtractedImport, name: string, exact: ReadonlyMap<string, ts.Declaration | null>): ImportResolution {
    const decl = exact.get(name) ?? null;
    // The name binds a whole workspace module (`export * as z from './x'` re-exported and imported as `{ z }`):
    // that is an import of the module, not of a symbol.
    const module = decl !== null && ctx.session.ts.isSourceFile(decl) ? moduleOfSourceFile(ctx, decl) : null;
    if (module !== null) return { type: 'imports', importIndex: imp.index, name: null, target: module, precision: 'exact' };
    const id = decl === null || ctx.session.ts.isSourceFile(decl) ? null : symbolOfDeclaration(ctx, decl);
    return id === null
      ? { type: 'imports_symbol', importIndex: imp.index, name, target: { kind: 'unresolved' }, precision: null }
      : { type: 'imports_symbol', importIndex: imp.index, name, target: { kind: 'symbol', id }, precision: 'exact' };
  }

  /** Phase 02 L1 fallback: the single exported top-level symbol of that name (`default`: the default export). */
  private heuristicBinding(ctx: ResolveContext, targetPath: CanonicalPath, imp: ExtractedImport, name: string): ImportResolution {
    const target = ctx.byPath.get(targetPath);
    const candidates = (target?.symbols ?? []).filter((s) => s.parent === null && s.exported && (name === 'default' ? s.defaultExport : s.name === name));
    const only = candidates.length === 1 ? candidates[0] : undefined;
    return only === undefined
      ? { type: 'imports_symbol', importIndex: imp.index, name, target: { kind: 'unresolved' }, precision: null }
      : { type: 'imports_symbol', importIndex: imp.index, name, target: { kind: 'symbol', id: only.id }, precision: 'heuristic' };
  }

  private push(out: StructuralEdge[], session: Session, extraction: FileExtraction, res: ImportResolution): void {
    const edge = createImportEdge(extraction, res, { producer: this.producer, profile: this.profileFor(extraction.language) }, this.hasher);
    if (edge.ok) out.push(edge.value);
    else session.diagnostics.push({ code: edge.error.code, message: edge.error.message, range: null, path: extraction.path });
  }

  private profileFor(language: LanguageId): CapabilityProfile {
    return this.profiles.find((p) => p.language === language) as CapabilityProfile;
  }

  private classify(session: Session, project: TsProject, file: CanonicalPath, imp: ExtractedImport): Classified {
    if (imp.specifier.kind === 'expression') return { target: { kind: 'unresolved' }, precision: null };
    const spec = imp.specifier.value;
    const resolved = this.resolveInWorkspace(session, project, file, spec, imp.isDynamic);
    if (resolved !== null) {
      const language = languageForPath(resolved);
      if (language === null) return { skip: 'IMPORT_TARGET_NOT_A_MODULE' };
      return { target: { kind: 'module', language: language as LanguageId, path: resolved }, precision: 'exact' };
    }
    const builtin = builtinName(spec);
    if (builtin !== null) return { target: { kind: 'external', ecosystem: 'node', name: builtin }, precision: 'exact' };
    const pkg = packageNameOf(spec);
    if (pkg === null || pathsCover(project.options, spec) || session.isWorkspacePackage(pkg)) return { target: { kind: 'unresolved' }, precision: null };
    return { target: { kind: 'external', ecosystem: 'npm', name: pkg }, precision: session.declares(file, pkg) ? 'exact' : 'heuristic' };
  }

  /** ts.resolveModuleName over the virtual workspace; the canonical path of a resolved workspace file, or null. */
  private resolveInWorkspace(session: Session, project: TsProject, file: CanonicalPath, spec: string, isDynamic: boolean): CanonicalPath | null {
    const typescript = session.ts;
    const containing = toVirtual(file);
    const mode = isDynamic ? typescript.ModuleKind.ESNext : typescript.getImpliedNodeFormatForFile(containing, undefined, session.host, project.options);
    const r = typescript.resolveModuleName(spec, containing, project.options, session.host, project.cache, undefined, mode);
    const name = r.resolvedModule?.resolvedFileName;
    if (name === undefined) return null;
    const path = fromVirtual(session.host.realpath(name));
    return path !== null && session.manifest.has(path) ? path : null;
  }
}

