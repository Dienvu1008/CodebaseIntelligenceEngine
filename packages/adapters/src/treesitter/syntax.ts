/**
 * Small, grammar-independent helpers over web-tree-sitter nodes: parse diagnostics, error-region checks and
 * bodyFingerprint. Nothing here leaks a tree-sitter type past the adapter (BOUNDED_CONTEXTS §3).
 */
import type { ContentHash, ExtractionDiagnostic, Hasher, SourceText } from '@cie/core';
import type { Node } from 'web-tree-sitter';

export const MAX_PARSE_DIAGNOSTICS = 20;

const sameNode = (a: Node, b: Node): boolean => a.startIndex === b.startIndex && a.endIndex === b.endIndex && a.type === b.type;

/** True when the node lies inside an ERROR region; such declarations are dropped (§6.3). */
export function inErrorRegion(node: Node): boolean {
  for (let n: Node | null = node; n !== null; n = n.parent) if (n.type === 'ERROR') return true;
  return false;
}

/** ERROR and MISSING nodes as diagnostics, in document order, capped at MAX_PARSE_DIAGNOSTICS. */
export function parseDiagnostics(root: Node, source: SourceText): ExtractionDiagnostic[] {
  const out: ExtractionDiagnostic[] = [];
  if (!root.hasError) return out;
  let total = 0;
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if (n.type === 'ERROR' || n.isMissing) {
      total++;
      if (out.length < MAX_PARSE_DIAGNOSTICS) {
        out.push({
          code: n.isMissing ? 'PARSE_MISSING' : 'PARSE_ERROR',
          message: n.isMissing ? `missing ${n.type}` : 'syntax error',
          range: source.rangeOf(n.startIndex, n.endIndex),
        });
      }
      if (n.type === 'ERROR') continue;
    }
    if (!n.hasError) continue;
    const children = n.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Node);
  }
  if (total > out.length) out.push({ code: 'PARSE_ERRORS_TRUNCATED', message: `${total - out.length} more parse errors not listed`, range: null });
  return out;
}

const NAME_MASK = '\u0001name';
const lf = (t: string): string => t.replace(/\r\n?/g, '\n');

/**
 * bodyFingerprint (ADR-0014): sha256 of the declaration's token stream with comments and whitespace dropped
 * (whitespace is never a token) and the declared name masked, so a rename alone keeps the fingerprint.
 * Token text has its line endings normalized, so CRLF and LF checkouts fingerprint alike.
 */
export function bodyFingerprint(decl: Node, name: Node | null, hasher: Hasher): ContentHash {
  const tokens: string[] = [];
  const stack: Node[] = [decl];
  while (stack.length > 0) {
    const n = stack.pop() as Node;
    if (n.type === 'comment') continue;
    if (name !== null && sameNode(n, name)) {
      tokens.push(NAME_MASK);
      continue;
    }
    const children = n.children;
    if (children.length === 0) {
      if (n.endIndex > n.startIndex) tokens.push(lf(n.text));
      continue;
    }
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Node);
  }
  return hasher.sha256Text(JSON.stringify(tokens));
}

/** Literal value of a string node made only of `fragment` children (no escapes or interpolation), else null. */
export function plainStringValue(node: Node, fragmentTypes: readonly string[], delimiterTypes: readonly string[] = []): string | null {
  let value = '';
  for (const c of node.namedChildren) {
    if (fragmentTypes.includes(c.type)) value += c.text;
    else if (!delimiterTypes.includes(c.type)) return null;
  }
  return value;
}
