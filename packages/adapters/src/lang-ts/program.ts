/**
 * A TypeScript Program per project over the snapshot (ADR-0016, Phase 03 P03-01).
 *  - The CompilerHost is the VirtualWorkspace: files, directories and contents come from the snapshot only
 *    (source texts were read through the root-confined FileSystem port and checked against the manifest
 *    hash). Nothing is read from the real disk, and nothing is ever written (`noEmit`).
 *  - `noLib` and `types: []`: no lib.d.ts and no automatic @types. Binding workspace declarations needs
 *    neither, and leaving them out keeps programs small and their results independent of the TypeScript
 *    installation and of installed packages.
 *  - Plugins are never enabled: `compilerOptions.plugins` was already removed at config parsing, and a plain
 *    Program has no plugin mechanism (plugins belong to tsserver's language service, which is never created).
 *  - Programs are built one at a time and dropped after use, so only one is alive at once (memory control).
 */
import type { CanonicalPath } from '@cie/core';
import type ts from 'typescript';
import { toVirtual, VIRTUAL_ROOT, type TypeScript, type VirtualWorkspace } from './virtual-host.js';

/** Compiler options of a CIE program: the project's options, made side-effect free. */
export function programOptions(typescript: TypeScript, options: ts.CompilerOptions): ts.CompilerOptions {
  const { plugins: _plugins, lib: _lib, incremental: _incremental, composite: _composite, tsBuildInfoFile: _info, ...rest } = options;
  return { ...rest, noLib: true, types: [], noEmit: true, skipLibCheck: true, checkJs: false, noResolve: false, module: rest.module ?? typescript.ModuleKind.ESNext };
}

function compilerHost(typescript: TypeScript, ws: VirtualWorkspace): ts.CompilerHost {
  return {
    getSourceFile: (fileName, languageVersionOrOptions) => {
      const text = ws.readFile(fileName);
      return text === undefined ? undefined : typescript.createSourceFile(fileName, text, languageVersionOrOptions, true);
    },
    getDefaultLibFileName: () => `${VIRTUAL_ROOT}/.cie-no-lib/lib.d.ts`, // never read: noLib
    writeFile: () => undefined,
    getCurrentDirectory: () => VIRTUAL_ROOT,
    getCanonicalFileName: (f) => f,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
    fileExists: (f) => ws.fileExists(f),
    readFile: (f) => ws.readFile(f),
    directoryExists: (d) => ws.directoryExists(d),
    getDirectories: (d) => ws.getDirectories(d),
    realpath: (p) => ws.realpath(p),
  };
}

export function buildProgram(typescript: TypeScript, ws: VirtualWorkspace, roots: readonly CanonicalPath[], options: ts.CompilerOptions): ts.Program {
  return typescript.createProgram({ rootNames: roots.map((r) => toVirtual(r)), options: programOptions(typescript, options), host: compilerHost(typescript, ws) });
}
