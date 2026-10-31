/**
 * SymbolIdentity (ADR-0014, SY-001): the only place where a SymbolId is constructed.
 *
 *   SymbolId := "<lang>:<modulePath>#<qualifiedName>(<kind>)[~<n>]"
 *
 * The id is a pure function of (language, modulePath, qualifiedName, kind, disambiguator), so re-extracting
 * identical content yields identical ids, and body edits or in-file moves leave ids unchanged.
 * The disambiguator `~n` appears only when several declarations in one module share (qualifiedName, kind),
 * for example overloads or redeclarations; n is the 1-based declaration order within that colliding set.
 * A name segment may not contain the characters that delimit the format, so every id parses back
 * unambiguously into its parts.
 */
import type { CanonicalPath, DomainError, Result, SymbolId } from '../../shared-kernel/index.js';
import { domainError, err, ok } from '../../shared-kernel/index.js';
import { languageId, type LanguageId } from './capability.js';

export type SymbolKind =
  | 'module'
  | 'namespace'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'enum_member'
  | 'function'
  | 'method'
  | 'constructor'
  | 'getter'
  | 'setter'
  | 'property'
  | 'variable'
  | 'constant';

export const SYMBOL_KINDS: readonly SymbolKind[] = [
  'module',
  'namespace',
  'class',
  'interface',
  'type',
  'enum',
  'enum_member',
  'function',
  'method',
  'constructor',
  'getter',
  'setter',
  'property',
  'variable',
  'constant',
];

/** Name used for default exports (ADR-0014). */
export const DEFAULT_EXPORT_NAME = 'default';

/** Placeholder segment for an unnamed declaration: `<anon@n>`, n = 1-based ordinal within its container. */
export function anonymousName(ordinal: number): string {
  return `<anon@${ordinal}>`;
}

// Delimiters of the id format, whitespace, control characters and lone surrogates.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_IN_SEGMENT = /[.#()~\s\u0000-\u001f\u007f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const ANON = /^<anon@[1-9][0-9]*>$/;

/** Validates one segment of a qualified name. `<anon@n>` placeholders are the only names allowed to use `<`/`>`. */
export function validateNameSegment(name: string): Result<string, DomainError> {
  if (name === '') return err(domainError('SYMBOL_NAME_INVALID', 'a symbol name must not be empty'));
  if (FORBIDDEN_IN_SEGMENT.test(name)) {
    return err(domainError('SYMBOL_NAME_INVALID', `symbol name "${name}" contains a reserved character (. # ( ) ~, whitespace or control)`, { name }));
  }
  if (name.startsWith('<') && !ANON.test(name)) {
    return err(domainError('SYMBOL_NAME_INVALID', `symbol name "${name}" starts with "<" but is not an <anon@n> placeholder`, { name }));
  }
  return ok(name);
}

export interface SymbolIdParts {
  readonly language: LanguageId;
  readonly modulePath: CanonicalPath;
  /** Dot-joined lexical container chain, e.g. `SessionStore.refresh`. */
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  /** 1-based, or null when the triple does not collide. */
  readonly disambiguator: number | null;
}

/** One declaration in a module, in declaration (source) order. */
export interface SymbolDeclaration {
  /** Name segments from the outermost container to the symbol itself. */
  readonly path: readonly string[];
  readonly kind: SymbolKind;
}

function format(p: SymbolIdParts): SymbolId {
  const suffix = p.disambiguator === null ? '' : `~${p.disambiguator}`;
  return `${p.language}:${p.modulePath}#${p.qualifiedName}(${p.kind})${suffix}` as SymbolId;
}

function validateQualifiedPath(path: readonly string[]): Result<string, DomainError> {
  if (path.length === 0) return err(domainError('SYMBOL_NAME_INVALID', 'a qualified name needs at least one segment'));
  for (const segment of path) {
    const v = validateNameSegment(segment);
    if (!v.ok) return v;
  }
  return ok(path.join('.'));
}

/**
 * Assigns ids to every declaration of one module. Ids are returned in input order. The disambiguator
 * depends on the declaration order, so callers must pass declarations in source order.
 */
export function identifySymbols(
  language: LanguageId,
  modulePath: CanonicalPath,
  declarations: readonly SymbolDeclaration[],
): Result<readonly SymbolId[], DomainError> {
  const keys: string[] = [];
  const counts = new Map<string, number>();
  for (const d of declarations) {
    if (!SYMBOL_KINDS.includes(d.kind)) return err(domainError('SYMBOL_KIND_INVALID', `unknown symbol kind "${String(d.kind)}"`, { kind: d.kind }));
    const qn = validateQualifiedPath(d.path);
    if (!qn.ok) return qn;
    // NUL cannot occur in a validated segment or kind, so it is a safe key separator.
    const key = `${qn.value}\u0000${d.kind}`;
    keys.push(key);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  const ids = declarations.map((d, i) => {
    const key = keys[i] as string;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return format({ language, modulePath, qualifiedName: d.path.join('.'), kind: d.kind, disambiguator: (counts.get(key) ?? 0) > 1 ? n : null });
  });
  return ok(ids);
}

const ID_TAIL = /^(.*)\(([a-z_]+)\)(?:~([1-9][0-9]*))?$/;

/**
 * Parses a stored id back into its parts and re-validates them; `parseSymbolId(id)` followed by formatting
 * returns exactly `id`. This is how ids read from storage or from clients become SymbolIds again.
 */
export function parseSymbolId(raw: string): Result<SymbolIdParts & { readonly id: SymbolId }, DomainError> {
  const bad = (why: string) => err(domainError('SYMBOL_ID_INVALID', `"${raw}" is not a SymbolId: ${why}`, { value: raw }));
  const colon = raw.indexOf(':');
  const hash = raw.lastIndexOf('#');
  if (colon <= 0 || hash <= colon + 1) return bad('expected <lang>:<modulePath>#…');
  const lang = languageId(raw.slice(0, colon));
  if (!lang.ok) return bad('invalid language');
  const modulePath = raw.slice(colon + 1, hash);
  const tail = ID_TAIL.exec(raw.slice(hash + 1));
  if (tail === null) return bad('expected …#<qualifiedName>(<kind>)[~n]');
  const [, qualifiedName = '', kindRaw = '', n] = tail;
  if (!(SYMBOL_KINDS as readonly string[]).includes(kindRaw)) return bad(`unknown kind "${kindRaw}"`);
  const qn = validateQualifiedPath(qualifiedName.split('.'));
  if (!qn.ok) return bad(qn.error.message);
  // The module path is checked for shape only: canonicalization belongs to the workspace context.
  if (modulePath.startsWith('/') || modulePath.endsWith('/') || modulePath.includes('//')) return bad('module path is not canonical');
  const parts: SymbolIdParts = {
    language: lang.value,
    modulePath: modulePath as CanonicalPath,
    qualifiedName,
    kind: kindRaw as SymbolKind,
    disambiguator: n === undefined ? null : Number(n),
  };
  const id = format(parts);
  if (id !== raw) return bad('not in canonical form');
  return ok({ ...parts, id });
}
