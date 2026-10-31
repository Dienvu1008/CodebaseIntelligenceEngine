/**
 * Exact import bindings through the TypeChecker (Phase 03 P03-03). For one import site of a file in a
 * Program, every name the import binds is followed through aliases (re-exports, barrels, `export … from`,
 * CommonJS `require` destructuring) to its final declaration. The caller maps declarations to SymbolIds.
 *
 * A name the checker cannot find yields `null`: that is exact knowledge that the binding does not exist,
 * recorded as an unresolved edge, never a guess (SY-006).
 */
import type ts from 'typescript';
import type { TypeScript } from './virtual-host.js';

/** The declaration a name binds to: implementation over overload signatures, first otherwise. */
function pick(typescript: TypeScript, decls: readonly ts.Declaration[] | undefined): ts.Declaration | null {
  if (decls === undefined || decls.length === 0) return null;
  const withBody = decls.find((d) => (typescript.isFunctionLike(d) && 'body' in d && d.body !== undefined) || typescript.isClassLike(d));
  return withBody ?? (decls[0] as ts.Declaration);
}

/** Follows aliases and CommonJS shorthand/property assignments to a declaration. */
export function finalDeclaration(typescript: TypeScript, checker: ts.TypeChecker, symbol: ts.Symbol | undefined): ts.Declaration | null {
  let s = symbol;
  for (let hop = 0; s !== undefined && hop < 8; hop++) {
    if ((s.flags & typescript.SymbolFlags.Alias) !== 0) {
      s = checker.getAliasedSymbol(s);
      continue;
    }
    const decl = pick(typescript, s.declarations);
    // A SourceFile: the name binds a whole module (`export * as ns from`); the caller turns it into a module import.
    if (decl === null || typescript.isSourceFile(decl)) return decl;
    if (typescript.isShorthandPropertyAssignment(decl)) {
      s = checker.getShorthandAssignmentValueSymbol(decl);
      continue;
    }
    if (typescript.isPropertyAssignment(decl) && typescript.isIdentifier(decl.initializer)) {
      s = checker.getSymbolAtLocation(decl.initializer);
      continue;
    }
    return decl;
  }
  return null;
}

const SITE_KINDS = (typescript: TypeScript): ReadonlySet<ts.SyntaxKind> =>
  new Set([typescript.SyntaxKind.ImportDeclaration, typescript.SyntaxKind.ExportDeclaration, typescript.SyntaxKind.CallExpression]);

/** The import, re-export or require node that starts exactly at `offset` (tree-sitter and tsc agree on starts). */
export function siteAt(typescript: TypeScript, sf: ts.SourceFile, offset: number): ts.Node | null {
  const kinds = SITE_KINDS(typescript);
  let found: ts.Node | null = null;
  const visit = (n: ts.Node): void => {
    if (found !== null || n.end <= offset || n.pos > offset) return;
    if (kinds.has(n.kind) && n.getStart(sf) === offset) {
      found = n;
      return;
    }
    typescript.forEachChild(n, visit);
  };
  typescript.forEachChild(sf, visit);
  return found;
}

const textOf = (typescript: TypeScript, n: ts.ModuleExportName | ts.PropertyName | ts.BindingName): string | null =>
  typescript.isIdentifier(n) || typescript.isStringLiteral(n) ? n.text : null;

function importDeclaration(typescript: TypeScript, checker: ts.TypeChecker, site: ts.ImportDeclaration, out: Map<string, ts.Declaration | null>): void {
  const clause = site.importClause;
  if (clause?.name !== undefined) out.set('default', finalDeclaration(typescript, checker, checker.getSymbolAtLocation(clause.name)));
  const bindings = clause?.namedBindings;
  if (bindings === undefined || !typescript.isNamedImports(bindings)) return;
  for (const el of bindings.elements) {
    const exported = textOf(typescript, el.propertyName ?? el.name);
    if (exported !== null) out.set(exported, finalDeclaration(typescript, checker, checker.getSymbolAtLocation(el.name)));
  }
}

function exportDeclaration(typescript: TypeScript, checker: ts.TypeChecker, site: ts.ExportDeclaration, out: Map<string, ts.Declaration | null>): void {
  const clause = site.exportClause;
  if (clause === undefined || !typescript.isNamedExports(clause)) return;
  for (const el of clause.elements) {
    const exported = textOf(typescript, el.propertyName ?? el.name);
    if (exported !== null) out.set(exported, finalDeclaration(typescript, checker, checker.getExportSpecifierLocalTargetSymbol(el)));
  }
}

function requireCall(typescript: TypeScript, checker: ts.TypeChecker, site: ts.CallExpression, out: Map<string, ts.Declaration | null>): void {
  const decl = site.parent;
  if (!typescript.isVariableDeclaration(decl) || decl.initializer !== site || !typescript.isObjectBindingPattern(decl.name)) return;
  for (const el of decl.name.elements) {
    const exported = textOf(typescript, el.propertyName ?? el.name);
    if (exported !== null && !el.dotDotDotToken) out.set(exported, finalDeclaration(typescript, checker, checker.getSymbolAtLocation(el.name)));
  }
}

/** Every bound name of the site → its final declaration (null: the name does not resolve). */
export function bindingsAt(typescript: TypeScript, checker: ts.TypeChecker, site: ts.Node): Map<string, ts.Declaration | null> {
  const out = new Map<string, ts.Declaration | null>();
  if (typescript.isImportDeclaration(site)) importDeclaration(typescript, checker, site, out);
  else if (typescript.isExportDeclaration(site)) exportDeclaration(typescript, checker, site, out);
  else if (typescript.isCallExpression(site)) requireCall(typescript, checker, site, out);
  return out;
}
