/**
 * TreeSitterExtractor: the L1 FileExtractor for TS, TSX, JS and Python (CODE_INTELLIGENCE_STRATEGY §2.1, §6).
 *
 * Per file: decode the exact bytes (decode.ts), parse, run the CIE-owned queries, and translate captures
 * into drafts for createFileExtraction, which assigns SymbolIds and enforces the domain checks.
 *  - Ranges come from parser offsets (UTF-16 code units) mapped through SourceText, the same mapping
 *    the SY-003 validator uses, so `spanHash = sha256(utf8(text(range)))` holds by construction.
 *  - Declarations inside ERROR regions are dropped and the parse errors are reported as diagnostics; the
 *    file still yields everything that parsed (§6.3).
 *  - Parents are found by range containment, so nesting works the same way for every grammar.
 * Grammars come from the vendored, integrity-checked artifacts (GrammarLoader); queries are compiled
 * once per extractor.
 */
import {
  anonymousName,
  capabilityProfile,
  createFileExtraction,
  domainError,
  encodeNameSegment,
  err,
  ok,
  producerIdentity,
  SourceText,
  type CancellationSignal,
  type CapabilityProfile,
  type DomainError,
  type FileExtraction,
  type FileExtractor,
  type FileInput,
  type Hasher,
  type ImportDraft,
  type LanguageId,
  type ProducerIdentity,
  type Result,
  type SymbolDraft,
} from '@cie/core';
import { Parser, Query, type Language, type Node } from 'web-tree-sitter';
import { NodeHasher } from '../fs/system.js';
import { decodeSource } from './decode.js';
import { JAVASCRIPT_RULES, TYPESCRIPT_RULES } from './ecmascript.js';
import { defaultGrammarLoader, type GrammarLoader } from './grammar-loader.js';
import { PYTHON_RULES } from './python.js';
import { prefixedCapture, capture, type LanguageRules, type RawDefinition, type RawImport } from './rules.js';
import { bodyFingerprint, inErrorRegion, parseDiagnostics } from './syntax.js';

/** Bump when extraction output can change for the same input (queries, kind rules, fingerprinting). */
export const TREESITTER_ADAPTER_VERSION = '0.1.0';

/** language id → vendored grammar (grammars.lock.json `language`) and rules. */
const LANGUAGES: readonly { readonly id: LanguageId; readonly grammar: string; readonly rules: LanguageRules }[] = [
  { id: 'ts', grammar: 'typescript', rules: TYPESCRIPT_RULES },
  { id: 'tsx', grammar: 'tsx', rules: TYPESCRIPT_RULES },
  { id: 'js', grammar: 'javascript', rules: JAVASCRIPT_RULES },
  { id: 'py', grammar: 'python', rules: PYTHON_RULES },
];

const L1_PROFILE = { symbols: 'L1', imports: 'L1', docstrings: 'L1', references: 'L0', calls: 'L0', typeRelations: 'L0', di: 'L0' };

interface CompiledLanguage {
  readonly language: Language;
  readonly rules: LanguageRules;
  readonly definitions: Query;
  readonly imports: Query;
  readonly profile: CapabilityProfile;
  readonly producer: ProducerIdentity;
}

const fail = (code: string, message: string, details?: Readonly<Record<string, unknown>>): Result<never, DomainError> => err(domainError(code, message, details));
const byPosition = (a: RawDefinition, b: RawDefinition): number => a.node.startIndex - b.node.startIndex || b.node.endIndex - a.node.endIndex;

/** Encodes a source name into a segment; an empty name becomes `<anon@n>`, n counted per parent. */
function segmentName(raw: string, parentIndex: number, anonymous: Map<number, number>): string {
  if (raw !== '') return encodeNameSegment(raw);
  const n = (anonymous.get(parentIndex) ?? 0) + 1;
  anonymous.set(parentIndex, n);
  return anonymousName(n);
}

export class TreeSitterExtractor implements FileExtractor {
  readonly profiles: readonly CapabilityProfile[];
  private readonly parser = new Parser();

  private constructor(
    readonly producer: ProducerIdentity,
    private readonly compiled: ReadonlyMap<string, CompiledLanguage>,
    private readonly hasher: Hasher,
  ) {
    this.profiles = [...compiled.values()].map((c) => c.profile);
  }

  /** Loads and verifies every vendored grammar once, and compiles the queries. */
  static async create(options: { readonly loader?: GrammarLoader; readonly hasher?: Hasher } = {}): Promise<Result<TreeSitterExtractor, DomainError>> {
    const loader = options.loader ?? defaultGrammarLoader();
    const lock = await loader.readLock();
    if (!lock.ok) return lock;
    const runtime = `${lock.value.runtime.package}@${lock.value.runtime.version}`;
    const producer = producerIdentity('treesitter', TREESITTER_ADAPTER_VERSION, runtime);
    if (!producer.ok) return producer;

    const compiled = new Map<string, CompiledLanguage>();
    for (const spec of LANGUAGES) {
      const entry = lock.value.grammars.find((g) => g.language === spec.grammar);
      const language = await loader.load(spec.grammar);
      if (!language.ok) return language;
      if (entry === undefined) return fail('GRAMMAR_UNKNOWN_LANGUAGE', `no vendored grammar for ${spec.grammar}`);
      const perLanguage = producerIdentity('treesitter', TREESITTER_ADAPTER_VERSION, `${runtime}+${entry.source.package}@${entry.source.version}`);
      const profile = capabilityProfile(spec.id, L1_PROFILE);
      if (!perLanguage.ok) return perLanguage;
      if (!profile.ok) return profile;
      compiled.set(spec.id, {
        language: language.value,
        rules: spec.rules,
        definitions: new Query(language.value, spec.rules.definitions),
        imports: new Query(language.value, spec.rules.imports),
        profile: profile.value,
        producer: perLanguage.value,
      });
    }
    return ok(new TreeSitterExtractor(producer.value, compiled, options.hasher ?? new NodeHasher()));
  }

  extractFile(input: FileInput, signal: CancellationSignal): Promise<Result<FileExtraction, DomainError>> {
    return Promise.resolve(this.extractSync(input, signal));
  }

  private extractSync(input: FileInput, signal: CancellationSignal): Result<FileExtraction, DomainError> {
    const lang = this.compiled.get(input.language);
    if (lang === undefined) return fail('EXTRACTION_UNSUPPORTED_LANGUAGE', `treesitter does not support "${input.language}"`, { language: input.language });
    if (signal.aborted) return fail('EXTRACTION_CANCELLED', 'extraction was cancelled');
    const decoded = decodeSource(input.content);
    if (!decoded.ok) return decoded;

    this.parser.setLanguage(lang.language);
    const tree = this.parser.parse(decoded.value.text);
    if (tree === null) return fail('EXTRACTION_PARSE_FAILED', `the parser returned no tree for ${input.path}`);
    try {
      const source = new SourceText(decoded.value.text);
      const root = tree.rootNode;
      return createFileExtraction({
        path: input.path,
        language: input.language,
        contentHash: input.contentHash,
        producer: lang.producer,
        profile: lang.profile,
        symbols: this.symbols(lang, root, source),
        imports: this.imports(lang, root, source),
        diagnostics: parseDiagnostics(root, source),
      });
    } finally {
      tree.delete();
    }
  }

  private definitions(lang: CompiledLanguage, root: Node): RawDefinition[] {
    const defs: RawDefinition[] = [];
    for (const m of lang.definitions.matches(root)) {
      const def = prefixedCapture(m, 'definition.');
      if (def === null || inErrorRegion(def.node)) continue;
      defs.push({ node: def.node, name: capture(m, 'name'), hint: def.hint });
    }
    return defs.sort(byPosition);
  }

  private symbols(lang: CompiledLanguage, root: Node, source: SourceText): SymbolDraft[] {
    const drafts: SymbolDraft[] = [];
    const stack: { def: RawDefinition; index: number }[] = [];
    const anonymous = new Map<number, number>(); // parent draft index (-1 = module) -> count
    for (const def of this.definitions(lang, root)) {
      while (stack.length > 0 && (stack.at(-1) as { def: RawDefinition }).def.node.endIndex <= def.node.startIndex) stack.pop();
      const parent = stack.at(-1) ?? null;
      const kind = lang.rules.kindOf(def, parent?.def ?? null);
      if (kind === null) continue;
      const { startIndex: start, endIndex: end } = def.node;
      drafts.push({
        name: segmentName(lang.rules.nameOf(def), parent?.index ?? -1, anonymous),
        kind,
        parent: parent?.index ?? null,
        range: source.rangeOf(start, end),
        spanHash: this.hasher.sha256Text(source.text.slice(start, end)),
        bodyFingerprint: bodyFingerprint(def.node, def.name, this.hasher),
        exported: lang.rules.exported(def, parent?.def ?? null),
        doc: lang.rules.doc(def),
      });
      stack.push({ def, index: drafts.length - 1 });
    }
    return drafts;
  }

  private imports(lang: CompiledLanguage, root: Node, source: SourceText): ImportDraft[] {
    const raw: RawImport[] = [];
    for (const m of lang.imports.matches(root)) {
      for (const imp of lang.rules.importsOf(m)) if (!inErrorRegion(imp.node)) raw.push(imp);
    }
    raw.sort((a, b) => a.node.startIndex - b.node.startIndex || a.node.endIndex - b.node.endIndex);
    return raw
      .filter((r) => (r.specifier.kind === 'literal' ? r.specifier.value : r.specifier.text) !== '')
      .map((r) => ({
        specifier: r.specifier,
        range: source.rangeOf(r.node.startIndex, r.node.endIndex),
        isDynamic: r.isDynamic,
        isTypeOnly: r.isTypeOnly,
        names: r.names,
      }));
  }
}
