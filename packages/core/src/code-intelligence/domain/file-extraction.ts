/**
 * FileExtraction: the value object every FileExtractor returns (CODE_INTELLIGENCE_STRATEGY §4), built only
 * through `createFileExtraction`. The factory is where SY-001, SY-005 and SY-006 meet the adapter output:
 *  - SymbolIds are assigned here by SymbolIdentity, never by the adapter (SY-001);
 *  - every symbol and import carries a ProducerRef with the fidelity the profile declares (SY-005);
 *  - a producer cannot emit facts for a capability it declares as L0, nor docstrings it does not support
 *    (SY-006: precision and coverage are never overstated);
 *  - ranges are valid, children lie inside their parents and declarations arrive in source order, which
 *    is what makes the `~n` disambiguator deterministic.
 * Third-party AST types never reach this module (BOUNDED_CONTEXTS §3): adapters translate into drafts.
 */
import type { CanonicalPath, ContentHash, DomainError, Result, SourceRange, SymbolId } from '../../shared-kernel/index.js';
import { domainError, err, ok, sourceRange } from '../../shared-kernel/index.js';
import { atLeast, producerRef, type Capability, type CapabilityProfile, type LanguageId, type ProducerIdentity, type ProducerRef } from './capability.js';
import { identifySymbols, type SymbolKind } from './symbol-identity.js';

declare const extractionBrand: unique symbol;

export interface SymbolDraft {
  readonly name: string;
  readonly kind: SymbolKind;
  /** Index of the enclosing declaration in the same draft list (it must come earlier), or null at module level. */
  readonly parent: number | null;
  readonly range: SourceRange;
  /** sha256 of the UTF-8 encoding of the decoded text in `range` (SY-003), computed by the adapter. */
  readonly spanHash: ContentHash;
  /** Hash of the normalized token stream with the symbol's own name masked (ADR-0014). */
  readonly bodyFingerprint: ContentHash;
  readonly exported: boolean;
  readonly doc: string | null;
}

/** A literal module specifier, or the raw text of a non-literal one (`import(expr)`, `require(name)`, `importlib.import_module(x)`). */
export type ImportSpecifier = { readonly kind: 'literal'; readonly value: string } | { readonly kind: 'expression'; readonly text: string };

export interface ImportDraft {
  readonly specifier: ImportSpecifier;
  readonly range: SourceRange;
  readonly isDynamic: boolean;
  readonly isTypeOnly: boolean;
  /** Exported-side names bound by the import (`default` for a default import); namespace imports bind none. */
  readonly names: readonly string[];
}

export interface ExtractionDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly range: SourceRange | null;
}

export interface ExtractedSymbol {
  readonly id: SymbolId;
  readonly parent: SymbolId | null;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly range: SourceRange;
  readonly spanHash: ContentHash;
  readonly bodyFingerprint: ContentHash;
  readonly exported: boolean;
  readonly doc: string | null;
  readonly producer: ProducerRef;
}

export interface ExtractedImport extends ImportDraft {
  /** 0-based position in `FileExtraction.imports`; resolvers cite it as evidence. */
  readonly index: number;
  readonly producer: ProducerRef;
}

export interface FileExtraction {
  readonly [extractionBrand]: true;
  readonly path: CanonicalPath;
  readonly language: LanguageId;
  readonly contentHash: ContentHash;
  readonly producer: ProducerIdentity;
  readonly profile: CapabilityProfile;
  readonly symbols: readonly ExtractedSymbol[];
  readonly imports: readonly ExtractedImport[];
  readonly diagnostics: readonly ExtractionDiagnostic[];
}

export interface FileExtractionInput {
  readonly path: CanonicalPath;
  readonly language: LanguageId;
  readonly contentHash: ContentHash;
  readonly producer: ProducerIdentity;
  readonly profile: CapabilityProfile;
  readonly symbols: readonly SymbolDraft[];
  readonly imports: readonly ImportDraft[];
  readonly diagnostics: readonly ExtractionDiagnostic[];
}

const before = (a: SourceRange, b: SourceRange): boolean => a.startLine < b.startLine || (a.startLine === b.startLine && a.startCol < b.startCol);
const endsAfter = (a: SourceRange, b: SourceRange): boolean => a.endLine > b.endLine || (a.endLine === b.endLine && a.endCol > b.endCol);
/** `inner` lies within `outer` (both end-exclusive). */
const within = (inner: SourceRange, outer: SourceRange): boolean => !before(inner, outer) && !endsAfter(inner, outer);

function checkRange(r: SourceRange, what: string): Result<SourceRange, DomainError> {
  const v = sourceRange(r.startLine, r.startCol, r.endLine, r.endCol);
  return v.ok ? v : err(domainError('EXTRACTION_RANGE_INVALID', `${what}: ${v.error.message}`, { ...v.error.details, what }));
}

function requireCapability(profile: CapabilityProfile, capability: Capability, count: number): Result<true, DomainError> {
  if (count === 0 || atLeast(profile.fidelity[capability], 'L1')) return ok(true);
  return err(
    domainError('SY_006_CAPABILITY_NOT_DECLARED', `the producer emitted ${count} ${capability} fact(s) but declares ${capability} as L0`, {
      language: profile.language,
      capability,
    }),
  );
}

function checkSymbols(symbols: readonly SymbolDraft[]): Result<readonly (readonly string[])[], DomainError> {
  const paths: (readonly string[])[] = [];
  for (const [i, s] of symbols.entries()) {
    const what = `symbol #${i} (${s.name})`;
    const range = checkRange(s.range, what);
    if (!range.ok) return range;
    const prev = symbols[i - 1];
    if (prev !== undefined && before(s.range, prev.range)) {
      return err(domainError('EXTRACTION_ORDER', `${what} starts before the previous declaration; drafts must be in source order`, { index: i }));
    }
    if (s.parent === null) {
      paths.push([s.name]);
      continue;
    }
    const parent = symbols[s.parent];
    const parentPath = paths[s.parent];
    if (!Number.isSafeInteger(s.parent) || s.parent < 0 || s.parent >= i || parent === undefined || parentPath === undefined) {
      return err(domainError('EXTRACTION_PARENT_INVALID', `${what} names parent #${s.parent}, which is not an earlier declaration`, { index: i }));
    }
    if (!within(s.range, parent.range)) {
      return err(domainError('EXTRACTION_PARENT_INVALID', `${what} is not inside its parent ${parent.name}`, { index: i, parent: s.parent }));
    }
    paths.push([...parentPath, s.name]);
  }
  return ok(paths);
}

function checkImport(d: ImportDraft, i: number): Result<true, DomainError> {
  const range = checkRange(d.range, `import #${i}`);
  if (!range.ok) return range;
  const text = d.specifier.kind === 'literal' ? d.specifier.value : d.specifier.text;
  if (text === '') return err(domainError('EXTRACTION_IMPORT_INVALID', `import #${i} has an empty specifier`, { index: i }));
  if (d.names.some((n) => n === '')) return err(domainError('EXTRACTION_IMPORT_INVALID', `import #${i} binds an empty name`, { index: i }));
  return ok(true);
}

function checkInput(input: FileExtractionInput): Result<readonly (readonly string[])[], DomainError> {
  const { profile } = input;
  if (profile.language !== input.language) {
    return err(domainError('CAPABILITY_LANGUAGE_MISMATCH', `profile is for "${profile.language}", the file is "${input.language}"`));
  }
  const docs = input.symbols.filter((s) => s.doc !== null).length;
  for (const [capability, count] of [['symbols', input.symbols.length], ['imports', input.imports.length], ['docstrings', docs]] as const) {
    const c = requireCapability(profile, capability, count);
    if (!c.ok) return c;
  }
  for (const [i, d] of input.imports.entries()) {
    const c = checkImport(d, i);
    if (!c.ok) return c;
  }
  for (const [i, d] of input.diagnostics.entries()) {
    if (d.range === null) continue;
    const c = checkRange(d.range, `diagnostic #${i}`);
    if (!c.ok) return c;
  }
  return checkSymbols(input.symbols);
}

export function createFileExtraction(input: FileExtractionInput): Result<FileExtraction, DomainError> {
  const paths = checkInput(input);
  if (!paths.ok) return paths;
  const declarations = input.symbols.map((s, i) => ({ path: paths.value[i] as readonly string[], kind: s.kind }));
  const ids = identifySymbols(input.language, input.path, declarations);
  if (!ids.ok) return ids;

  const symbolProducer = producerRef(input.producer, input.profile, 'symbols');
  const importProducer = producerRef(input.producer, input.profile, 'imports');
  const symbols = input.symbols.map(
    (s, i): ExtractedSymbol => ({
      id: ids.value[i] as SymbolId,
      parent: s.parent === null ? null : (ids.value[s.parent] as SymbolId),
      name: s.name,
      qualifiedName: (paths.value[i] as readonly string[]).join('.'),
      kind: s.kind,
      range: s.range,
      spanHash: s.spanHash,
      bodyFingerprint: s.bodyFingerprint,
      exported: s.exported,
      doc: s.doc,
      producer: symbolProducer,
    }),
  );
  const imports = input.imports.map((d, index): ExtractedImport => ({ ...d, names: [...d.names], index, producer: importProducer }));
  const extraction: Omit<FileExtraction, typeof extractionBrand> = {
    path: input.path,
    language: input.language,
    contentHash: input.contentHash,
    producer: input.producer,
    profile: input.profile,
    symbols,
    imports,
    diagnostics: [...input.diagnostics],
  };
  return ok(extraction as FileExtraction);
}
