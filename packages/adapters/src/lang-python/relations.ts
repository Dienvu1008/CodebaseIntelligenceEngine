/**
 * Python references and calls (Phase 03, P03-08; CODE_INTELLIGENCE_STRATEGY §5): binding of the free-name
 * uses the tree-sitter extractor reports (`FileExtraction.occurrences`, which already excludes declarations,
 * attribute names and names local to a function) against the module scope of the file:
 *  - the file's own top-level symbols;
 *  - names bound by `from X import n` that the import resolution mapped to a symbol of X.
 * A top-level definition shadows an import of the same name (definitions usually follow the imports).
 *
 * Every edge is heuristic (L2, status inferred): Python has no static guarantee that the name is not
 * rebound at runtime (`globals()`, monkey-patching, conditional definitions).
 *  - each use of a bound name is a `references` occurrence (the projection merges them per (from, to));
 *  - each direct call `name(…)` of a bound name is also a `calls` edge for that site.
 * Not recorded:
 *  - attribute calls (`obj.method()`): the type of `obj` is unknown at L2;
 *  - names that are not bound in the module scope (builtins, star imports, `import x as y` module objects);
 *  - `from X import a as b`: the alias is not in the import draft, so `b` is not bound (a known gap).
 * There are no unresolved placeholders: an unbound name is not evidence of a dynamic call.
 */
import type { FileExtraction, RelationResolution, SourceRange, SymbolId } from '@cie/core';

const startsBefore = (a: SourceRange, b: SourceRange): boolean => a.startLine < b.startLine || (a.startLine === b.startLine && a.startCol < b.startCol);
const endsAfter = (a: SourceRange, b: SourceRange): boolean => a.endLine > b.endLine || (a.endLine === b.endLine && a.endCol > b.endCol);
const contains = (outer: SourceRange, inner: SourceRange): boolean => !startsBefore(inner, outer) && !endsAfter(inner, outer);

/** The extracted symbol with the smallest range containing `range`, or null at module level. */
function enclosing(extraction: FileExtraction, range: SourceRange): SymbolId | null {
  // Symbols are in source order and nested ranges follow their parents: the last container is innermost.
  let best: SymbolId | null = null;
  for (const s of extraction.symbols) {
    if (startsBefore(range, s.range)) break;
    if (contains(s.range, range)) best = s.id;
  }
  return best;
}

/** The module scope of a file: imported symbols first, then its own top-level symbols (which win). */
export function moduleScope(extraction: FileExtraction, imported: ReadonlyMap<string, SymbolId>): Map<string, SymbolId> {
  const scope = new Map(imported);
  for (const s of extraction.symbols) if (s.parent === null) scope.set(s.name, s.id);
  return scope;
}

export function pythonRelations(extraction: FileExtraction, scope: ReadonlyMap<string, SymbolId>): RelationResolution[] {
  const out: RelationResolution[] = [];
  for (const o of extraction.occurrences) {
    const target = scope.get(o.name);
    if (target === undefined) continue;
    const from = enclosing(extraction, o.range);
    out.push({ type: 'references', from, target: { kind: 'symbol', id: target }, range: o.range, raw: o.name, precision: 'heuristic' });
    if (o.call) out.push({ type: 'calls', from, target: { kind: 'symbol', id: target }, range: o.range, raw: o.name, precision: 'heuristic' });
  }
  return out;
}
