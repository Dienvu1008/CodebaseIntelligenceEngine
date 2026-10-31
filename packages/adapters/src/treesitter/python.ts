/**
 * Python rules for the tree-sitter extractor (L1: syntax only).
 *  - Kinds: a `def` directly in a class body is a method (`__init__` is the constructor); class-level
 *    assignments are properties; module-level assignments are variables.
 *  - exported: Python has no export statement. A module-level name not starting with `_` is public by
 *    convention; `__all__` is not evaluated at L1.
 *  - doc: the docstring, i.e. a plain string literal as the first statement of the body.
 *  - imports: `import a.b`, `from .x import y`, and `importlib.import_module(x)` / `__import__(x)`
 *    (dynamic; a non-literal argument is an expression and can only resolve to an unresolved node, SY-006).
 */
import type { ImportSpecifier, SymbolKind } from '@cie/core';
import type { Node, QueryMatch } from 'web-tree-sitter';
import { PYTHON_DEFINITIONS, PYTHON_IMPORTS } from './queries.js';
import { capture, prefixedCapture, type LanguageRules, type RawDefinition, type RawImport } from './rules.js';
import { plainStringValue } from './syntax.js';

/** A plain (non-f, non-bytes) string's value; prefixes like `r` or `u` keep the literal readable as text. */
function literalString(node: Node): string | null {
  if (node.type !== 'string') return null;
  const start = node.namedChildren.find((c) => c.type === 'string_start')?.text ?? '';
  if (/[fFbB]/.test(start)) return null;
  return plainStringValue(node, ['string_content'], ['string_start', 'string_end']);
}

function inClassBody(node: Node): boolean {
  let p = node.parent;
  if (p?.type === 'decorated_definition') p = p.parent;
  return p?.type === 'block' && p.parent?.type === 'class_definition';
}

function kindOf(def: RawDefinition): SymbolKind | null {
  if (def.hint !== 'function') return def.hint as SymbolKind;
  if (!inClassBody(def.node)) return 'function';
  return def.name?.text === '__init__' ? 'constructor' : 'method';
}

function doc(def: RawDefinition): string | null {
  const body = def.node.childForFieldName('body');
  const first = body?.namedChildren[0];
  if (first?.type !== 'expression_statement') return null;
  const str = first.namedChildren[0];
  const value = str === undefined ? null : literalString(str);
  if (value === null) return null;
  const text = value.replace(/\r\n?/g, '\n').trim();
  return text === '' ? null : text;
}

function dottedText(n: Node | null): string {
  if (n === null) return '';
  return n.type === 'aliased_import' ? (n.childForFieldName('name')?.text ?? '') : n.text;
}

function plainImports(stmt: Node): RawImport[] {
  return stmt.namedChildren
    .filter((c) => c.type === 'dotted_name' || c.type === 'aliased_import')
    .map((c) => ({ node: stmt, specifier: { kind: 'literal', value: dottedText(c) }, isDynamic: false, isTypeOnly: false, names: [] }));
}

function fromImport(stmt: Node): RawImport[] {
  const module = stmt.childForFieldName('module_name');
  if (module === null) return [];
  const names = stmt.childrenForFieldName('name').map((n) => dottedText(n)).filter((n) => n !== '');
  return [{ node: stmt, specifier: { kind: 'literal', value: module.text }, isDynamic: false, isTypeOnly: false, names }];
}

function dynamicImport(call: Node, source: Node): RawImport[] {
  const value = literalString(source);
  const specifier: ImportSpecifier = value !== null && value !== '' ? { kind: 'literal', value } : { kind: 'expression', text: source.text };
  return [{ node: call, specifier, isDynamic: true, isTypeOnly: false, names: [] }];
}

function importsOf(match: QueryMatch): readonly RawImport[] {
  const site = prefixedCapture(match, 'import.');
  if (site === null) return [];
  if (site.hint === 'static') return plainImports(site.node);
  if (site.hint === 'from') return fromImport(site.node);
  const source = capture(match, 'source');
  return source === null ? [] : dynamicImport(site.node, source);
}

export const PYTHON_RULES: LanguageRules = {
  definitions: PYTHON_DEFINITIONS,
  imports: PYTHON_IMPORTS,
  kindOf,
  nameOf: (def) => def.name?.text ?? '',
  exported: (def, parent) => parent === null && !(def.name?.text ?? '_').startsWith('_'),
  defaultExport: () => false, // Python has no default export
  doc,
  importsOf,
};
