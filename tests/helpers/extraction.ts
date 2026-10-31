// Builders for code-intelligence domain tests: profiles, producers and FileExtraction drafts.
import { NodeHasher } from '@cie/adapters';
import {
  capabilityProfile,
  createFileExtraction,
  producerIdentity,
  type CanonicalPath,
  type CapabilityProfile,
  type ContentHash,
  type Fidelity,
  type FileExtraction,
  type FileExtractionInput,
  type ImportDraft,
  type LanguageId,
  type ProducerIdentity,
  type SourceRange,
  type SymbolDraft,
} from '@cie/core';

export const hasher = new NodeHasher();

export function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

export const range = (startLine: number, startCol: number, endLine: number, endCol: number): SourceRange => ({ startLine, startCol, endLine, endCol });
export const hashOf = (text: string): ContentHash => hasher.sha256Text(text);

/** A profile with every capability at `base`, overridden per capability. */
export function profile(language: LanguageId, base: Fidelity, overrides: Partial<Record<string, Fidelity>> = {}): CapabilityProfile {
  const all = { symbols: base, imports: base, references: base, calls: base, typeRelations: base, di: base, docstrings: base, ...overrides };
  return unwrap(capabilityProfile(language, all as Record<string, string>));
}

export const producer = (adapterId = 'treesitter', adapterVersion = '0.1.0', toolVersion = 'web-tree-sitter@0.27.1'): ProducerIdentity =>
  unwrap(producerIdentity(adapterId, adapterVersion, toolVersion));

export function symbol(name: string, kind: SymbolDraft['kind'], r: SourceRange, parent: number | null = null, extra: Partial<SymbolDraft> = {}): SymbolDraft {
  return { name, kind, parent, range: r, spanHash: hashOf(`${name}@${r.startLine}`), bodyFingerprint: hashOf(`body:${name}`), exported: false, doc: null, ...extra };
}

export function literalImport(value: string, r: SourceRange, names: readonly string[] = [], extra: Partial<ImportDraft> = {}): ImportDraft {
  return { specifier: { kind: 'literal', value }, range: r, isDynamic: false, isTypeOnly: false, names, ...extra };
}

export function expressionImport(text: string, r: SourceRange): ImportDraft {
  return { specifier: { kind: 'expression', text }, range: r, isDynamic: true, isTypeOnly: false, names: [] };
}

type Overrides = Partial<Omit<FileExtractionInput, 'path'>> & { path?: string };

export function extraction(overrides: Overrides = {}): FileExtraction {
  return unwrap(createFileExtraction(extractionInput(overrides)));
}

export function extractionInput(overrides: Overrides = {}): FileExtractionInput {
  const language = overrides.language ?? ('ts' as LanguageId);
  return {
    language,
    contentHash: hashOf('content'),
    producer: producer(),
    profile: profile(language, 'L1'),
    symbols: [],
    imports: [],
    diagnostics: [],
    ...overrides,
    path: (overrides.path ?? 'src/a.ts') as CanonicalPath,
  };
}
