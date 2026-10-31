/**
 * TypeScript project discovery (CODE_INTELLIGENCE_STRATEGY §6.4).
 *  - Projects are the `tsconfig.json` and `jsconfig.json` files of the snapshot, like tsc and tsserver do by
 *    default. Other `tsconfig.*.json` files take part only through `extends`.
 *  - Each config is parsed with the TypeScript config parser over the VirtualWorkspace. `extends` and
 *    `include`/`exclude`/`files` behave as in tsc. `compilerOptions.plugins` is removed: lang-ts never
 *    builds a language service, and nothing from a plugin list is ever loaded (A-06).
 *  - A file belongs to the project with the deepest config directory among those that list it (ties: config
 *    path order). Files listed by no project go to the inferred project (allowJs, bundler resolution).
 */
import type { CanonicalPath, ExtractionDiagnostic } from '@cie/core';
import ts from 'typescript';
import { fromVirtual, toVirtual, type VirtualWorkspace } from './virtual-host.js';

export interface TsProject {
  readonly kind: 'tsconfig' | 'inferred';
  readonly config: CanonicalPath | null;
  readonly options: ts.CompilerOptions;
  readonly cache: ts.ModuleResolutionCache;
}

export type ProjectDiagnostic = ExtractionDiagnostic & { readonly path: CanonicalPath | null };

export const INFERRED_OPTIONS: ts.CompilerOptions = {
  allowJs: true,
  checkJs: false,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  resolveJsonModule: true,
};

const CONFIG_NAMES = new Set(['tsconfig.json', 'jsconfig.json']);
const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const depth = (p: string): number => (p === '' ? 0 : p.split('/').length);

export const isProjectConfig = (p: CanonicalPath): boolean => CONFIG_NAMES.has(baseName(p));

function cacheFor(options: ts.CompilerOptions): ts.ModuleResolutionCache {
  return ts.createModuleResolutionCache(toVirtual(''), (s) => s, options);
}

function parseProject(config: CanonicalPath, host: VirtualWorkspace, diagnostics: ProjectDiagnostic[]): { project: TsProject; files: readonly CanonicalPath[] } {
  const v = toVirtual(config);
  const text = ts.parseConfigFileTextToJson(v, host.readFile(v) ?? '');
  const existing: ts.CompilerOptions = baseName(config) === 'jsconfig.json' ? { allowJs: true, maxNodeModuleJsDepth: 0 } : {};
  const parsed = ts.parseJsonConfigFileContent(text.config ?? {}, host, toVirtual(dirName(config) as CanonicalPath | ''), existing, v);
  // 18003 ("no inputs were found") is not a problem for import resolution.
  const errors = [...(text.error === undefined ? [] : [text.error]), ...parsed.errors].filter((d) => d.code !== 18003);
  for (const d of errors) {
    diagnostics.push({ code: 'TSCONFIG_ERROR', message: `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`, range: null, path: config });
  }
  const { plugins: _plugins, ...options } = parsed.options; // never loaded (A-06)
  const files = parsed.fileNames.map(fromVirtual).filter((f): f is CanonicalPath => f !== null);
  return { project: { kind: 'tsconfig', config, options, cache: cacheFor(options) }, files };
}

export interface ProjectAssignment {
  readonly projects: readonly TsProject[];
  readonly inferred: TsProject;
  projectOf(file: CanonicalPath): TsProject;
}

export function discoverProjects(manifestPaths: readonly CanonicalPath[], host: VirtualWorkspace, diagnostics: ProjectDiagnostic[]): ProjectAssignment {
  const configs = manifestPaths.filter(isProjectConfig).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const owner = new Map<CanonicalPath, TsProject>();
  const projects: TsProject[] = [];
  for (const config of configs) {
    const { project, files } = parseProject(config, host, diagnostics);
    projects.push(project);
    for (const f of files) {
      const current = owner.get(f);
      if (current === undefined || depth(dirName(config)) > depth(dirName(current.config ?? ''))) owner.set(f, project);
    }
  }
  const inferred: TsProject = { kind: 'inferred', config: null, options: INFERRED_OPTIONS, cache: cacheFor(INFERRED_OPTIONS) };
  return { projects, inferred, projectOf: (file) => owner.get(file) ?? inferred };
}
