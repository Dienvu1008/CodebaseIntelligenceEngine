/**
 * Language adapter ports (CODE_INTELLIGENCE_STRATEGY §4). Two ports, because there are two granularities:
 *  - FileExtractor: pure and per file. The same bytes and the same producer version always give the same
 *    FileExtraction (SY-001), so extraction can be parallelized and cached by content hash.
 *  - ProjectResolver: cross-file and stateful (tsconfig programs, Python source roots). It turns extracted
 *    imports into edges, built with createImportEdge so SY-006 holds at construction.
 * Third-party AST and compiler types never cross these ports (BOUNDED_CONTEXTS §3).
 *
 * Refinements of the §4 sketch (recorded in the Phase 02 sign-off):
 *  - `supports(lang)` / `profile(lang)` become a `profiles` list: a registry can validate it up front, and an
 *    adapter cannot answer differently on each call;
 *  - both methods return Results, like every other port; adapter failures are data, not exceptions;
 *  - `producer` is a ProducerIdentity; facts carry ProducerRef with per-capability fidelity (C-12).
 */
import type { CancellationSignal, CanonicalPath, ContentHash, DomainError, Result } from '../../shared-kernel/index.js';
import type { FileSystem, ManifestEntry } from '../../workspace/public.js';
import type { CapabilityProfile, LanguageId, ProducerIdentity } from '../domain/capability.js';
import type { ExtractionDiagnostic, FileExtraction } from '../domain/file-extraction.js';
import type { StructuralEdge } from '../domain/import-edge.js';

export interface FileInput {
  readonly path: CanonicalPath;
  readonly language: LanguageId;
  /** Exact bytes as hashed in the manifest; spans and span hashes are computed from these. */
  readonly content: Uint8Array;
  readonly contentHash: ContentHash;
}

export interface LanguageAdapter {
  readonly producer: ProducerIdentity;
  /** One profile per supported language; languages must be distinct. */
  readonly profiles: readonly CapabilityProfile[];
}

export interface FileExtractor extends LanguageAdapter {
  /**
   * Extracts one file. A parse error is not a failure: partial trees still yield symbols, and the error is
   * reported in `diagnostics`. An error result means the file could not be processed at all (for example
   * EXTRACTION_UNSUPPORTED_LANGUAGE, EXTRACTION_UNDECODABLE, EXTRACTION_CANCELLED).
   */
  extractFile(input: FileInput, signal: CancellationSignal): Promise<Result<FileExtraction, DomainError>>;
}

/** A project unit discovered by a resolver: a tsconfig, the synthesized inferred TS project, or a Python source root. */
export interface ProjectDescriptor {
  readonly kind: 'tsconfig' | 'inferred' | 'python-root';
  readonly language: LanguageId;
  /** Config file backing the project (tsconfig.json), or null for inferred projects and source roots. */
  readonly config: CanonicalPath | null;
  /** Root directory, or null for the workspace root. */
  readonly root: CanonicalPath | null;
}

export interface ProjectInput {
  /** The whole snapshot, in canonical path order: resolvers check target existence against it. */
  readonly manifest: readonly ManifestEntry[];
  /** Extractions to resolve (all files on a full index; the affected set on an incremental run). */
  readonly extractions: readonly FileExtraction[];
  /** Root-confined, read-only access for configuration files (tsconfig.json, pyproject.toml). */
  readonly fs: FileSystem;
}

export interface ProjectResolution {
  readonly edges: readonly StructuralEdge[];
  readonly projects: readonly ProjectDescriptor[];
  readonly diagnostics: readonly (ExtractionDiagnostic & { readonly path: CanonicalPath | null })[];
  /** Incremental runs (Phase 05): dependents that must be re-resolved. */
  readonly affectedFiles?: readonly CanonicalPath[];
}

export interface ProjectResolver extends LanguageAdapter {
  resolve(input: ProjectInput, signal: CancellationSignal): Promise<Result<ProjectResolution, DomainError>>;
}
