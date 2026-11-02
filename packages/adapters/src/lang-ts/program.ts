/**
 * A TypeScript Program per project over the snapshot (ADR-0016, Phase 03 P03-01, P03-07).
 *  - The CompilerHost is the VirtualWorkspace: workspace files, directories and contents come from the
 *    snapshot only (source texts were read through the root-confined FileSystem port and checked against the
 *    manifest hash). The workspace is never read from the real disk, and nothing is ever written (`noEmit`).
 *  - The standard library is the compiler's own: lib files are read from the `lib` directory of the pinned
 *    `typescript` package that CIE ships with (part of CIE's installation, never the workspace), chosen by the
 *    project's `lib` / `target` exactly as tsc chooses them. The pinned version is in the producer's
 *    `toolVersion`, so results stay deterministic. Lib SourceFiles are parsed once and shared by every Program.
 *    Without them, calls and references through strings, arrays, promises and callbacks cannot be bound
 *    (measured in P03-07: about 2,000 spurious unresolved calls and up to 1,500 missed references per repo).
 *  - `types: []`: no automatic @types; installed packages are never read.
 *  - Plugins are never enabled: `compilerOptions.plugins` was already removed at config parsing, and a plain
 *    Program has no plugin mechanism (plugins belong to tsserver's language service, which is never created).
 *  - Programs are built one at a time and dropped after use, so only one is alive at once (memory control).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { CanonicalPath } from '@cie/core';
import type ts from 'typescript';
import { toVirtual, VIRTUAL_ROOT, type TypeScript, type VirtualWorkspace } from './virtual-host.js';

/** `lib` directory of the pinned compiler, with `/` separators. */
const LIB_DIR = path.join(path.dirname(createRequire(import.meta.url).resolve('typescript/package.json')), 'lib').replaceAll('\\', '/');
const LIB_FILE = /^lib(\.[a-z0-9.]+)?\.d\.ts$/i;

/** Parsed lib files, shared across Programs and resolutions: keyed by file and parse options. */
const libSourceFiles = new Map<string, ts.SourceFile>();
const libTexts = new Map<string, string | null>();

/** True only for a lib file directly in the compiler's lib directory (no traversal, no other files). */
function isLibFile(fileName: string): boolean {
  if (!fileName.startsWith(`${LIB_DIR}/`)) return false;
  const name = fileName.slice(LIB_DIR.length + 1);
  return !name.includes('/') && LIB_FILE.test(name);
}

function libText(fileName: string): string | undefined {
  if (!libTexts.has(fileName)) {
    let text: string | null = null;
    try {
      text = readFileSync(fileName, 'utf8');
    } catch {
      text = null; // tsc names lib files that this TypeScript version does not ship: absent, like tsc
    }
    libTexts.set(fileName, text);
  }
  return libTexts.get(fileName) ?? undefined;
}

function libSourceFile(typescript: TypeScript, fileName: string, languageVersionOrOptions: ts.ScriptTarget | ts.CreateSourceFileOptions): ts.SourceFile | undefined {
  const key = `${fileName}|${JSON.stringify(languageVersionOrOptions)}`;
  const cached = libSourceFiles.get(key);
  if (cached !== undefined) return cached;
  const text = libText(fileName);
  if (text === undefined) return undefined;
  const sf = typescript.createSourceFile(fileName, text, languageVersionOrOptions, true);
  libSourceFiles.set(key, sf);
  return sf;
}

/** Compiler options of a CIE program: the project's options, made side-effect free. */
export function programOptions(typescript: TypeScript, options: ts.CompilerOptions): ts.CompilerOptions {
  const { plugins: _plugins, noLib: _noLib, incremental: _incremental, composite: _composite, tsBuildInfoFile: _info, ...rest } = options;
  return { ...rest, types: [], noEmit: true, skipLibCheck: true, checkJs: false, noResolve: false, module: rest.module ?? typescript.ModuleKind.ESNext };
}

function compilerHost(typescript: TypeScript, ws: VirtualWorkspace): ts.CompilerHost {
  return {
    getSourceFile: (fileName, languageVersionOrOptions) => {
      if (isLibFile(fileName)) return libSourceFile(typescript, fileName, languageVersionOrOptions);
      const text = ws.readFile(fileName);
      return text === undefined ? undefined : typescript.createSourceFile(fileName, text, languageVersionOrOptions, true);
    },
    getDefaultLibFileName: (o) => `${LIB_DIR}/${typescript.getDefaultLibFileName(o)}`,
    getDefaultLibLocation: () => LIB_DIR,
    writeFile: () => undefined,
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => (isLibFile(f) ? libText(f) !== undefined : ws.fileExists(f)),
    readFile: (f) => (isLibFile(f) ? libText(f) : ws.readFile(f)),
    directoryExists: (d) => ws.directoryExists(d),
    getDirectories: (d) => ws.getDirectories(d),
    realpath: (p) => ws.realpath(p),
  };
}

export function buildProgram(typescript: TypeScript, ws: VirtualWorkspace, roots: readonly CanonicalPath[], options: ts.CompilerOptions): ts.Program {
  return typescript.createProgram({ rootNames: roots.map((r) => toVirtual(r)), options: programOptions(typescript, options), host: compilerHost(typescript, ws) });
}
