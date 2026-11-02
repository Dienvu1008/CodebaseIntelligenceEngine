/**
 * Symbol relations through the TypeChecker (Phase 03, P03-07; KNOWLEDGE_GRAPH_DESIGN §3): one walk over a
 * source file in a Program yields `references`, `references_type`, `calls`, `extends` and `implements`
 * resolutions between extracted symbols. Every concrete target is what tsc binds the name to (followed
 * through import aliases), mapped to its extracted SymbolId: exact (L3).
 *
 *  - An identifier occurrence that resolves to an extracted workspace symbol is a reference: `references_type`
 *    in a type position, `references` otherwise. Declaration names, import and export declarations
 *    (recorded as imports) and heritage clauses (recorded as extends / implements) are not references.
 *  - A call or `new` whose callee resolves to an extracted symbol is a `calls` edge for that call site. A
 *    callee that is syntactically dynamic (`handlers[k]()`, `make()()`) or that tsc cannot bind at all is a
 *    `calls` edge to an unresolved placeholder: SY-006, never a guess.
 *  - Targets outside the workspace (lib, node_modules) and declarations that are not extracted symbols
 *    (parameters, locals, object-literal members) are not recorded.
 *  - The source is the innermost extracted symbol around the occurrence, or the module for top-level code.
 */
import type { FileExtraction, RelationResolution, SourceRange, SourceText, SymbolId } from '@cie/core';
import type ts from 'typescript';
import { finalDeclaration } from './bindings.js';
import type { TypeScript } from './virtual-host.js';

export interface RelationInput {
  readonly typescript: TypeScript;
  readonly checker: ts.TypeChecker;
  readonly sf: ts.SourceFile;
  readonly extraction: FileExtraction;
  readonly source: SourceText;
  /** The extracted SymbolId of a declaration, or null (outside the workspace, not extracted). */
  symbolOf(decl: ts.Declaration): SymbolId | null;
  /** True for source files of the snapshot (false for lib and external declarations). */
  isWorkspaceFile(sf: ts.SourceFile): boolean;
}

interface Interval {
  readonly start: number;
  readonly end: number;
  readonly id: SymbolId;
  readonly parent: number | null;
}

/** Innermost extracted symbol around an offset: symbol ranges nest (children lie inside their parents). */
class EnclosingSymbols {
  private readonly intervals: Interval[] = [];

  constructor(extraction: FileExtraction, source: SourceText) {
    const index = new Map<SymbolId, number>();
    for (const s of extraction.symbols) {
      const start = source.offsetOf(s.range.startLine, s.range.startCol);
      const end = source.offsetOf(s.range.endLine, s.range.endCol);
      if (start === null || end === null) continue;
      index.set(s.id, this.intervals.length);
      this.intervals.push({ start, end, id: s.id, parent: s.parent === null ? null : (index.get(s.parent) ?? null) });
    }
  }

  at(offset: number): SymbolId | null {
    let lo = 0;
    let hi = this.intervals.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((this.intervals[mid] as Interval).start <= offset) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    for (let i: number | null = found < 0 ? null : found; i !== null; ) {
      const iv = this.intervals[i] as Interval;
      if (offset < iv.end) return iv.id;
      i = iv.parent;
    }
    return null;
  }
}

/** Calls whose callee is one of these unbound names are imports (`require`) or language constructs. */
const NOT_CALLS = new Set(['require']);

class Walker {
  readonly out: RelationResolution[] = [];
  private readonly ts: TypeScript;
  private readonly enclosing: EnclosingSymbols;

  constructor(private readonly input: RelationInput) {
    this.ts = input.typescript;
    this.enclosing = new EnclosingSymbols(input.extraction, input.source);
  }

  private range(n: ts.Node): SourceRange {
    return this.input.source.rangeOf(n.getStart(this.input.sf), n.getEnd());
  }

  private targetOf(symbol: ts.Symbol | undefined): SymbolId | 'none' | null {
    if (symbol === undefined) return 'none';
    const decl = finalDeclaration(this.ts, this.input.checker, symbol);
    if (decl === null) return 'none';
    return this.ts.isSourceFile(decl) ? null : this.input.symbolOf(decl);
  }

  private push(type: RelationResolution['type'], at: ts.Node, target: SymbolId | null, raw: string): void {
    const from = this.enclosing.at(at.getStart(this.input.sf));
    if ((type === 'extends' || type === 'implements') && from === null) return;
    this.out.push({
      type,
      from,
      target: target === null ? { kind: 'unresolved' } : { kind: 'symbol', id: target },
      range: this.range(at),
      raw,
      precision: target === null ? null : 'exact',
    });
  }

  /** `name === id` on these parents is a use, not a declaration. */
  private isDeclarationName(id: ts.Identifier): boolean {
    const p = id.parent;
    if (this.ts.isPropertyAccessExpression(p) || this.ts.isShorthandPropertyAssignment(p)) return false;
    return (p as { name?: ts.Node }).name === id;
  }

  private identifier(id: ts.Identifier, inType: boolean): void {
    if (this.isDeclarationName(id)) return;
    const p = id.parent;
    const symbol = this.ts.isShorthandPropertyAssignment(p) && p.name === id ? this.input.checker.getShorthandAssignmentValueSymbol(p) : this.input.checker.getSymbolAtLocation(id);
    const target = this.targetOf(symbol);
    if (target === null || target === 'none') return;
    this.push(inType ? 'references_type' : 'references', id, target, id.text);
  }

  private call(call: ts.CallExpression | ts.NewExpression): void {
    let callee: ts.Expression = call.expression;
    while (this.ts.isParenthesizedExpression(callee) || this.ts.isNonNullExpression(callee)) callee = callee.expression;
    if (callee.kind === this.ts.SyntaxKind.SuperKeyword || callee.kind === this.ts.SyntaxKind.ImportKeyword) return;
    const name = this.ts.isIdentifier(callee) ? callee : this.ts.isPropertyAccessExpression(callee) && this.ts.isIdentifier(callee.name) ? callee.name : null;
    const raw = callee.getText(this.input.sf);
    if (name === null) {
      this.push('calls', callee, null, raw); // syntactically dynamic callee
      return;
    }
    const target = this.targetOf(this.input.checker.getSymbolAtLocation(name));
    if (target === 'none') {
      if (this.rootIsWorkspaceValue(callee)) this.push('calls', name, null, raw);
      return;
    }
    if (target !== null) this.push('calls', name, target, raw);
  }

  /**
   * True when the leftmost name of a callee chain (`a` in `a.b.c()`, or `this`) is a workspace value. An
   * unbound callee on such a value has an unknown target (an `any` value, a missing member): unresolved. A
   * chain rooted in an external import or an undeclared global goes outside the workspace: not recorded.
   */
  private rootIsWorkspaceValue(callee: ts.Expression): boolean {
    let root: ts.Expression = callee;
    while (this.ts.isPropertyAccessExpression(root) || this.ts.isElementAccessExpression(root) || this.ts.isCallExpression(root) || this.ts.isNonNullExpression(root) || this.ts.isParenthesizedExpression(root)) root = root.expression;
    if (root.kind === this.ts.SyntaxKind.ThisKeyword) return true;
    if (!this.ts.isIdentifier(root)) return true; // a literal or other expression: a value of this file
    if (NOT_CALLS.has(root.text) && root === callee) return false;
    const symbol = this.input.checker.getSymbolAtLocation(root);
    if (symbol === undefined) return false; // undeclared global
    const decl = finalDeclaration(this.ts, this.input.checker, symbol);
    if (decl === null) return false; // an import that leaves the workspace
    return this.input.isWorkspaceFile(decl.getSourceFile());
  }

  private heritage(clause: ts.HeritageClause): void {
    const type = clause.token === this.ts.SyntaxKind.ExtendsKeyword ? 'extends' : 'implements';
    for (const t of clause.types) {
      const e = t.expression;
      const name = this.ts.isIdentifier(e) ? e : this.ts.isPropertyAccessExpression(e) && this.ts.isIdentifier(e.name) ? e.name : null;
      const target = name === null ? null : this.targetOf(this.input.checker.getSymbolAtLocation(name));
      if (name !== null && target !== null && target !== 'none') this.push(type, name, target, name.text);
      else if (name === null) this.visit(e, false); // `extends mixin(Base)`: the call and its arguments are ordinary code
      for (const arg of t.typeArguments ?? []) this.visit(arg, true);
    }
  }

  visit(node: ts.Node, inType: boolean): void {
    const ts_ = this.ts;
    if (ts_.isImportDeclaration(node) || ts_.isImportEqualsDeclaration(node) || ts_.isExportDeclaration(node)) return;
    if (ts_.isHeritageClause(node)) {
      this.heritage(node);
      return;
    }
    if (ts_.isIdentifier(node)) {
      this.identifier(node, inType);
      return;
    }
    if (ts_.isCallExpression(node) || ts_.isNewExpression(node)) this.call(node);
    const childInType = inType || ts_.isTypeNode(node);
    ts_.forEachChild(node, (c) => this.visit(c, childInType));
  }
}

export function collectRelations(input: RelationInput): RelationResolution[] {
  const walker = new Walker(input);
  input.typescript.forEachChild(input.sf, (c) => walker.visit(c, false));
  return walker.out;
}

/**
 * True for declarations that are never extracted symbols: parameters (except TypeScript parameter
 * properties, which are class members) and variables below module level.
 */
export function isLocalValue(typescript: TypeScript, decl: ts.Declaration): boolean {
  if (typescript.isParameter(decl)) return !typescript.isParameterPropertyDeclaration(decl, decl.parent);
  if (typescript.isBindingElement(decl)) return true;
  if (!typescript.isVariableDeclaration(decl)) return false;
  const statement = decl.parent.parent;
  return !(typescript.isVariableStatement(statement) && (typescript.isSourceFile(statement.parent) || typescript.isModuleBlock(statement.parent)));
}
