/**
 * TypeScript, TSX and JavaScript rules for the tree-sitter extractor (L1: syntax only).
 *  - Kinds: `get`/`set` methods become getter/setter, `constructor` becomes constructor; a module-level
 *    `const` bound to a function or class is a function or class, other `const`s are constants, `let`/`var`
 *    are variables; `export default <anonymous>` is named `default`.
 *  - exported: the declaration sits directly in an `export` statement. `export { a as b }` clauses and
 *    re-exports are resolved by lang-ts (L3), not here.
 *  - doc: the `/** … *\/` comment that ends on the line right before the declaration (or its export).
 *  - imports: `import … from`, `export … from`, `import(x)`, `require(x)` and TS `import x = require(…)`.
 *    A non-literal argument is recorded as an expression; it can only ever resolve to an unresolved node (SY-006).
 */
import { DEFAULT_EXPORT_NAME, type ImportSpecifier, type SymbolKind } from '@cie/core';
import type { Node, QueryMatch } from 'web-tree-sitter';
import { ECMASCRIPT_IMPORTS, JAVASCRIPT_DEFINITIONS, TYPESCRIPT_DEFINITIONS, TYPESCRIPT_IMPORTS } from './queries.js';
import { capture, prefixedCapture, type LanguageRules, type RawDefinition, type RawImport } from './rules.js';
import { plainStringValue } from './syntax.js';

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const CLASS_VALUES = new Set(['class']);

const hasToken = (node: Node, token: string): boolean => node.children.some((c) => !c.isNamed && c.type === token);

/** `const x = require('m')`: an import binding (like `import x from 'm'`), not a declaration of its own. */
function isRequireBinding(value: Node | null): boolean {
  return value?.type === 'call_expression' && value.childForFieldName('function')?.text === 'require';
}

function variableKind(declarator: Node): SymbolKind | null {
  const value = declarator.childForFieldName('value');
  if (isRequireBinding(value)) return null;
  if (value !== null && FUNCTION_VALUES.has(value.type)) return 'function';
  if (value !== null && CLASS_VALUES.has(value.type)) return 'class';
  const declaration = declarator.parent;
  return declaration !== null && hasToken(declaration, 'const') ? 'constant' : 'variable';
}

function methodKind(def: RawDefinition): SymbolKind {
  if (hasToken(def.node, 'get')) return 'getter';
  if (hasToken(def.node, 'set')) return 'setter';
  return def.name?.text === 'constructor' ? 'constructor' : 'method';
}

function kindOf(def: RawDefinition): SymbolKind | null {
  switch (def.hint) {
    case 'variable':
      return variableKind(def.node);
    case 'method':
      return methodKind(def);
    case 'default':
      return CLASS_VALUES.has(def.node.type) ? 'class' : 'function';
    default:
      return def.hint as SymbolKind;
  }
}

function nameOf(def: RawDefinition): string {
  if (def.hint === 'default') return def.node.childForFieldName('name')?.text ?? DEFAULT_EXPORT_NAME;
  const name = def.name;
  if (name === null) return DEFAULT_EXPORT_NAME;
  // String-keyed members: `"q r"() {}` is named by its value, not by its quotes.
  if (name.type === 'string') return plainStringValue(name, ['string_fragment']) ?? name.text;
  return name.text;
}

/** The statement that carries a declaration's export keyword and doc comment. */
function statementOf(def: RawDefinition): Node {
  let n = def.node;
  if (def.hint === 'variable' && n.parent !== null) n = n.parent; // declarator -> lexical/variable declaration
  return n.parent?.type === 'export_statement' ? n.parent : n;
}

function exported(def: RawDefinition): boolean {
  return statementOf(def).type === 'export_statement';
}

/** `export default function f() {}`, `export default class {}`, …: the export statement has a `default` token. */
function defaultExport(def: RawDefinition, parent: RawDefinition | null): boolean {
  const stmt = statementOf(def);
  return parent === null && stmt.type === 'export_statement' && hasToken(stmt, 'default');
}

function cleanJsDoc(text: string): string {
  const body = text.replace(/^\/\*\*/, '').replace(/\*\/$/, '');
  return body
    .split(/\r\n?|\n/)
    .map((l) => l.replace(/^\s*\* ?/, '').trimEnd())
    .join('\n')
    .trim();
}

function doc(def: RawDefinition): string | null {
  const stmt = statementOf(def);
  const prev = stmt.previousSibling;
  if (prev === null || prev.type !== 'comment' || !prev.text.startsWith('/**')) return null;
  if (prev.endPosition.row < stmt.startPosition.row - 1) return null; // separated by a blank line
  const text = cleanJsDoc(prev.text);
  return text === '' ? null : text;
}

function specifierOf(source: Node): ImportSpecifier {
  if (source.type === 'string') {
    const value = plainStringValue(source, ['string_fragment']);
    if (value !== null && value !== '') return { kind: 'literal', value };
  }
  return { kind: 'expression', text: source.text };
}

function importedNames(stmt: Node): string[] {
  const names: string[] = [];
  const clause = stmt.namedChildren.find((c) => c.type === 'import_clause');
  for (const c of clause?.namedChildren ?? []) {
    if (c.type === 'identifier') names.push(DEFAULT_EXPORT_NAME);
    if (c.type === 'named_imports') for (const s of c.namedChildren) if (s.type === 'import_specifier') names.push(nameText(s.childForFieldName('name')));
  }
  const exportClause = stmt.namedChildren.find((c) => c.type === 'export_clause');
  for (const s of exportClause?.namedChildren ?? []) if (s.type === 'export_specifier') names.push(nameText(s.childForFieldName('name')));
  return names.filter((n) => n !== '');
}

const nameText = (n: Node | null): string => (n === null ? '' : n.type === 'string' ? (plainStringValue(n, ['string_fragment']) ?? n.text) : n.text);

function importsOf(match: QueryMatch): readonly RawImport[] {
  const site = prefixedCapture(match, 'import.');
  const source = capture(match, 'source');
  if (site === null || source === null) return [];
  const specifier = specifierOf(source);
  switch (site.hint) {
    case 'static':
    case 'reexport':
      return [{ node: site.node, specifier, isDynamic: false, isTypeOnly: hasToken(site.node, 'type'), names: importedNames(site.node) }];
    case 'dynamic':
      return [{ node: site.node, specifier, isDynamic: true, isTypeOnly: false, names: [] }];
    default: // require
      return [{ node: site.node, specifier, isDynamic: specifier.kind === 'expression', isTypeOnly: false, names: [] }];
  }
}

const base = { kindOf, nameOf, exported, defaultExport, doc, importsOf };

export const TYPESCRIPT_RULES: LanguageRules = { ...base, definitions: TYPESCRIPT_DEFINITIONS, imports: TYPESCRIPT_IMPORTS };
export const JAVASCRIPT_RULES: LanguageRules = { ...base, definitions: JAVASCRIPT_DEFINITIONS, imports: ECMASCRIPT_IMPORTS };
