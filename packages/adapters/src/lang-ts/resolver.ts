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
 * Non-literal specifiers always go to unresolved. Named bindings of module imports become `imports_symbol`
 * edges, heuristic: the target is the single exported top-level symbol with that name in the target's L1
 * extraction (TypeChecker-exact binding is Phase 03). Zero or several candidates → unresolved.
 */
import {
  capabilityProfile,
  createImportEdge,
  domainError,
  err,
  languageForPath,
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
import { builtinName, packageNameOf } from './builtins.js';
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
    // Nothing to resolve: do not load the compiler at all.
    if (!input.extractions.some((x) => LANGUAGES.includes(x.language))) return ok({ edges: [], projects: [], diagnostics: [] });
    const typescript = await loadTypeScript();
    const contents = new Map<string, string>();
    for (const e of input.manifest) {
      if (e.status !== 'indexed' || !isConfigFile(e.path)) continue;
      const bytes = await input.fs.readFile(e.path, signal);
      if (bytes.ok) contents.set(toVirtual(e.path), new TextDecoder().decode(bytes.value));
    }
    if (signal.aborted) return err(domainError('RESOLUTION_CANCELLED', 'resolution was cancelled'));

    const session = new Session(typescript, input.manifest, contents);
    const byPath = new Map(input.extractions.map((x) => [x.path, x] as const));
    const used = new Set<TsProject>();
    const edges: StructuralEdge[] = [];
    for (const extraction of [...input.extractions].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      if (!LANGUAGES.includes(extraction.language)) continue;
      if (signal.aborted) return err(domainError('RESOLUTION_CANCELLED', 'resolution was cancelled'));
      const project = session.projectOf(extraction.path);
      used.add(project);
      for (const imp of extraction.imports) edges.push(...this.edgesFor(session, project, extraction, imp, byPath));
    }
    return ok({ edges, projects: session.descriptors(used), diagnostics: session.diagnostics });
  }

  private edgesFor(session: Session, project: TsProject, extraction: FileExtraction, imp: ExtractedImport, byPath: ReadonlyMap<CanonicalPath, FileExtraction>): StructuralEdge[] {
    const c = this.classify(session, project, extraction.path, imp);
    if ('skip' in c) {
      session.diagnostics.push({ code: c.skip, message: `import of ${JSON.stringify(imp.specifier)} not recorded (${c.skip})`, range: imp.range, path: extraction.path });
      return [];
    }
    const out: StructuralEdge[] = [];
    this.push(out, session, extraction, { type: 'imports', importIndex: imp.index, name: null, target: c.target, precision: c.precision });
    if (c.target.kind !== 'module') return out;
    const target = byPath.get(c.target.path);
    for (const name of imp.names) {
      // `default` binds the module's default export, whatever its declared name (`export default function shout`).
      const candidates = (target?.symbols ?? []).filter((s) => s.parent === null && s.exported && (name === 'default' ? s.defaultExport : s.name === name));
      const only = candidates.length === 1 ? candidates[0] : undefined;
      const res: ImportResolution =
        only === undefined
          ? { type: 'imports_symbol', importIndex: imp.index, name, target: { kind: 'unresolved' }, precision: null }
          : { type: 'imports_symbol', importIndex: imp.index, name, target: { kind: 'symbol', id: only.id }, precision: 'heuristic' };
      this.push(out, session, extraction, res);
    }
    return out;
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

