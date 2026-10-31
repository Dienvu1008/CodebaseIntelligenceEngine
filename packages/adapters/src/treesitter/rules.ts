/** Contract between the generic tree-sitter extractor and the per-language rules (ecmascript.ts, python.ts). */
import type { ImportSpecifier, SymbolKind } from '@cie/core';
import type { Node, QueryMatch } from 'web-tree-sitter';

/** One `@definition.<hint>` capture with its optional `@name`. */
export interface RawDefinition {
  readonly node: Node;
  readonly name: Node | null;
  readonly hint: string;
}

export interface RawImport {
  readonly node: Node;
  readonly specifier: ImportSpecifier;
  readonly isDynamic: boolean;
  readonly isTypeOnly: boolean;
  readonly names: readonly string[];
}

export interface LanguageRules {
  readonly definitions: string;
  readonly imports: string;
  /** Final kind, or null to drop the capture. `parent` is the enclosing definition, if any. */
  kindOf(def: RawDefinition, parent: RawDefinition | null): SymbolKind | null;
  /** The source-level name (encoded into a segment by the extractor). */
  nameOf(def: RawDefinition): string;
  exported(def: RawDefinition, parent: RawDefinition | null): boolean;
  doc(def: RawDefinition): string | null;
  importsOf(match: QueryMatch): readonly RawImport[];
}

export function capture(match: QueryMatch, name: string): Node | null {
  return match.captures.find((c) => c.name === name)?.node ?? null;
}

/** The capture whose name starts with `prefix`, with the rest of the name as the hint. */
export function prefixedCapture(match: QueryMatch, prefix: string): { node: Node; hint: string } | null {
  const c = match.captures.find((x) => x.name.startsWith(prefix));
  return c === undefined ? null : { node: c.node, hint: c.name.slice(prefix.length) };
}
