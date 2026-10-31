/**
 * IgnoreEvaluator (FR-003, DOMAIN_MODEL Ã‚Â§6): pure .gitignore semantics, with no dependencies.
 *
 * It is verified against real git (`git ls-files --others --exclude-standard`) in
 * packages/core/test/ignore-evaluator.git-oracle.spec.ts on Windows and Linux.
 *
 * Supported gitignore semantics:
 *  - blank lines; `#` comments; `\#` and `\!` escapes; trailing spaces trimmed unless escaped; CRLF input
 *  - `!` negation, with the last matching rule winning
 *  - a trailing `/` makes a rule match directories only
 *  - a `/` at the start or in the middle anchors the rule to its file's directory; otherwise it matches
 *    at any depth
 *  - `*`, `?`, `[...]` (including `!`/`^` negation, ranges and POSIX classes), none of them matching `/`
 *  - `**` as a whole segment: leading `**\/`, trailing `/**`, middle `/**\/`
 *  - a deeper .gitignore overrides a shallower one
 *  - a path inside an ignored directory is ignored, and no negation can re-include it
 *
 * Deliberate differences from git (PHASE_01_SIGNOFF):
 *  - Matching is always case-sensitive, even where git defaults to core.ignorecase=true (Windows),
 *    so that every OS produces the same manifest (WS-004).
 *  - Layers: CIE defaults (lowest) < .gitignore files (by depth) < cie.config.json `ignore` (highest).
 *    git's info/exclude and core.excludesFile are not read: they are machine-local, so honoring them
 *    would make indexes differ between machines.
 */
import type { CanonicalPath } from '../../shared-kernel/index.js';

export type IgnoreLayer = 'default' | 'gitignore' | 'config';
export type EntryKind = 'file' | 'directory';

export interface IgnoreSource {
  readonly layer: IgnoreLayer;
  /** Directory the patterns are relative to; null means the workspace root. */
  readonly base: CanonicalPath | null;
  readonly text: string;
  /** Human-readable origin, e.g. "src/.gitignore" or "cie-defaults". Used in explanations. */
  readonly origin: string;
}

export interface IgnoreRule {
  readonly pattern: string;
  readonly origin: string;
  readonly line: number;
  readonly negated: boolean;
  readonly directoryOnly: boolean;
  readonly base: CanonicalPath | null;
  readonly layer: IgnoreLayer;
}

export interface IgnoreDecision {
  readonly ignored: boolean;
  /** The rule that decided the outcome, if any (a negation rule when the path was re-included). */
  readonly rule: IgnoreRule | null;
  /** Set when the path is ignored because an ancestor directory is ignored. */
  readonly ignoredAncestor: CanonicalPath | null;
}

/**
 * CIE default exclusions (FR-003). They sit in the lowest layer, so a repository can re-include an
 * entry with a negation in its .gitignore (e.g. `!dist/`).
 */
export const CIE_DEFAULT_IGNORES = [
  '.git/',
  '.cie/',
  'node_modules/',
  'dist/',
  'coverage/',
  '*.tsbuildinfo',
  '__pycache__/',
  '*.py[cod]',
  '.venv/',
  'venv/',
  '.mypy_cache/',
  '.pytest_cache/',
  '.tox/',
].join('\n');

interface CompiledRule extends IgnoreRule {
  readonly regex: RegExp | null; // null: the pattern is malformed and never matches (like git)
}

const baseDepth = (base: CanonicalPath | null): number => (base === null ? 0 : base.split('/').length);

const LAYER_RANK: Record<IgnoreLayer, number> = { default: 0, gitignore: 1, config: 2 };

const POSIX_CLASSES: Record<string, string> = {
  alnum: 'a-zA-Z0-9',
  alpha: 'a-zA-Z',
  blank: ' \\t',
  cntrl: '\\x00-\\x1f\\x7f',
  digit: '0-9',
  graph: '\\x21-\\x7e',
  lower: 'a-z',
  print: '\\x20-\\x7e',
  punct: '!-\\/:-@\\[-`{-~',
  space: ' \\t\\n\\r\\f\\v',
  upper: 'A-Z',
  xdigit: '0-9A-Fa-f',
};

const escapeRegex = (c: string): string => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const escapeClassChar = (c: string): string => (/[\\\]^-]/.test(c) ? `\\${c}` : c);

/** One parsed piece of a bracket expression: regex class text plus the index after it. */
type BracketItem = { readonly text: string; readonly next: number } | null;

/** `[:name:]` at body[i]. */
function readPosixClass(body: string, i: number): BracketItem {
  const close = body.indexOf(':]', i + 2);
  if (close === -1) return null;
  const cls = POSIX_CLASSES[body.slice(i + 2, close)];
  return cls === undefined ? null : { text: cls, next: close + 2 };
}

/** A single (possibly backslash-escaped) character at body[i]. */
function readClassChar(body: string, i: number): { readonly char: string; readonly next: number } | null {
  if (body[i] !== '\\') return { char: body[i] as string, next: i + 1 };
  const escaped = body[i + 1];
  return escaped === undefined ? null : { char: escaped, next: i + 2 };
}

/** A character or an `a-z` range at body[i]. An inverted range contributes nothing. */
function readCharOrRange(body: string, i: number): BracketItem {
  const lo = readClassChar(body, i);
  if (lo === null) return null;
  if (body[lo.next] !== '-' || body[lo.next + 1] === undefined || body[lo.next + 1] === ']') {
    return { text: escapeClassChar(lo.char), next: lo.next };
  }
  const hi = readClassChar(body, lo.next + 1);
  if (hi === null) return null;
  return { text: lo.char <= hi.char ? `${escapeClassChar(lo.char)}-${escapeClassChar(hi.char)}` : '', next: hi.next };
}

/** Parses a bracket expression starting at body[start] === '['. Returns null if it is not a valid class. */
function parseBracket(body: string, start: number): { re: string; end: number } | null {
  let i = start + 1;
  const negated = body[i] === '!' || body[i] === '^';
  if (negated) i++;
  let items = '';
  for (let first = true; i < body.length; first = false) {
    if (body[i] === ']' && !first) {
      if (negated) return { re: `[^/${items}]`, end: i + 1 };
      return { re: items === '' ? '(?!)' : `(?!/)[${items}]`, end: i + 1 };
    }
    const item = body[i] === '[' && body[i + 1] === ':' ? readPosixClass(body, i) : readCharOrRange(body, i);
    if (item === null) return null;
    items += item.text;
    i = item.next;
  }
  return null; // no closing bracket: '[' is literal
}

/** Translates a gitignore glob body into an anchored-at-start-free regex fragment. */
function globToRegex(body: string): string {
  let re = '';
  let i = 0;
  while (i < body.length) {
    const c = body[i] as string;
    if (c === '*') {
      const wholeSegment = body[i + 1] === '*' && (i === 0 || body[i - 1] === '/') && (i + 2 === body.length || body[i + 2] === '/');
      if (wholeSegment) {
        if (i + 2 === body.length) {
          re += '.*'; // trailing '**' or '/**': everything inside
          i += 2;
        } else {
          re += '(?:.*/)?'; // leading '**/' or middle '/**/': zero or more directories
          i += 3;
        }
        continue;
      }
      while (body[i] === '*') i++;
      re += '[^/]*';
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      const bracket = parseBracket(body, i);
      if (bracket) {
        re += bracket.re;
        i = bracket.end;
      } else {
        re += '\\[';
        i++;
      }
      continue;
    }
    if (c === '\\') {
      const escaped = body[i + 1];
      if (escaped === undefined) return '(?!)'; // a trailing backslash makes the pattern invalid
      re += escapeRegex(escaped);
      i += 2;
      continue;
    }
    re += escapeRegex(c);
    i++;
  }
  return re;
}

/** Trims trailing spaces unless they are escaped with a backslash (git's trim_trailing_spaces). */
function trimTrailingSpaces(line: string): string {
  let end = line.length;
  while (end > 0 && line[end - 1] === ' ') {
    let backslashes = 0;
    for (let k = end - 2; k >= 0 && line[k] === '\\'; k--) backslashes++;
    if (backslashes % 2 === 1) break;
    end--;
  }
  return line.slice(0, end);
}

function compileLine(raw: string, lineNo: number, source: IgnoreSource): CompiledRule | null {
  let line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line === '' || line.startsWith('#')) return null;
  line = trimTrailingSpaces(line);
  if (line === '') return null;
  const negated = line.startsWith('!');
  let body = negated ? line.slice(1) : line;
  const directoryOnly = body.endsWith('/') && !body.endsWith('\\/');
  if (directoryOnly) body = body.slice(0, -1);
  if (body === '') return null;
  const anchored = body.includes('/');
  if (body.startsWith('/')) body = body.slice(1);
  const fragment = globToRegex(body);
  let regex: RegExp | null;
  try {
    regex = new RegExp(anchored ? `^${fragment}$` : `^(?:.*/)?${fragment}$`);
  } catch {
    regex = null;
  }
  return {
    pattern: raw.replace(/\r$/, ''),
    origin: source.origin,
    line: lineNo,
    negated,
    directoryOnly,
    base: source.base,
    layer: source.layer,
    regex,
  };
}

function relativeTo(path: string, base: CanonicalPath | null): string | null {
  if (base === null) return path;
  return path.startsWith(`${base}/`) ? path.slice(base.length + 1) : null;
}

export class IgnoreEvaluator {
  private constructor(
    private readonly sources: readonly IgnoreSource[],
    private readonly rules: readonly CompiledRule[],
  ) {}

  static from(sources: readonly IgnoreSource[]): IgnoreEvaluator {
    const compiled = sources.map((source, index) => ({
      index,
      source,
      rules: source.text
        .split('\n')
        .map((line, i) => compileLine(line, i + 1, source))
        .filter((r): r is CompiledRule => r !== null),
    }));
    // Precedence, lowest first: layer, then depth of the .gitignore's directory, then input order.
    compiled.sort(
      (a, b) =>
        LAYER_RANK[a.source.layer] - LAYER_RANK[b.source.layer] ||
        baseDepth(a.source.base) - baseDepth(b.source.base) ||
        a.index - b.index,
    );
    return new IgnoreEvaluator(sources, compiled.flatMap((c) => c.rules));
  }

  /** Returns a new evaluator with one more source (e.g. a nested .gitignore found while walking). */
  with(source: IgnoreSource): IgnoreEvaluator {
    return IgnoreEvaluator.from([...this.sources, source]);
  }

  /** Decision for the entry itself, without looking at ancestors. */
  private matchSelf(path: string, kind: EntryKind): IgnoreRule | null {
    let decided: IgnoreRule | null = null;
    for (const rule of this.rules) {
      if (rule.regex === null || (rule.directoryOnly && kind !== 'directory')) continue;
      const rel = relativeTo(path, rule.base);
      if (rel !== null && rule.regex.test(rel)) decided = rule;
    }
    return decided;
  }

  explain(path: CanonicalPath, kind: EntryKind): IgnoreDecision {
    const segments = path.split('/');
    for (let depth = 1; depth < segments.length; depth++) {
      const ancestor = segments.slice(0, depth).join('/');
      const rule = this.matchSelf(ancestor, 'directory');
      if (rule !== null && !rule.negated) {
        return { ignored: true, rule, ignoredAncestor: ancestor as CanonicalPath };
      }
    }
    const rule = this.matchSelf(path, kind);
    return { ignored: rule !== null && !rule.negated, rule, ignoredAncestor: null };
  }

  isIgnored(path: CanonicalPath, kind: EntryKind): boolean {
    return this.explain(path, kind).ignored;
  }
}
