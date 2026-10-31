# Code Intelligence Strategy

> Status: Baseline v0.1 · Related: ADR-0006, ADR-0010, ADR-0011, ADR-0014, ADR-0016, SY-* invariants

## 1. Goals and authority model

Structural facts come from deterministic tools. Each fact records its **producer** (SY-005) and **precision** (SY-006). Precision cannot be faked: an L1 producer cannot emit an `exact` edge.

| Fidelity | Meaning | Typical producer | Edge precision | Claim status |
|---|---|---|---|---|
| L0 | Not supported | — | — | `unknown` (explicit gap) |
| L1 | Syntactic: the construct exists at this span | tree-sitter | (no cross-file edges) | `verified` for existence and location only |
| L2 | Heuristically resolved: deterministic but not proven | name and path heuristics | `heuristic` | `inferred` (producer kind `heuristic`) |
| L3 | Semantically exact | TS compiler, SCIP, LSP | `exact` | `verified` |

## 2. Technology evaluation

### 2.1 Tree-sitter

| Aspect | Assessment |
|---|---|
| Multi-language parsing | Excellent. A uniform CST API; grammars exist for every target language. [Fact] TS, TSX and Python grammars ship WASM (E-03, E-04). |
| Incremental parsing | Supported natively (edit plus reparse). CIE re-parses at file granularity in the MVP. Intra-file incremental parsing is a later optimization, because CIE's unit of change is the file hash. |
| Grammar availability | TS/TSX (0.23.2), Python (0.25.0), JS (0.25.0, ships its own `.wasm`, E-34). The four artifacts are vendored with a provenance lock (ADR-0010). Dart grammar exists (used by CodeForge via tree-sitter-wasms, E-26). |
| Symbol extraction | Via queries (`tags.scm` style). CIE owns its query files (ADR-0010). Gives L1 outline, spans and docstrings. Tree-sitter has no name resolution. |
| Maintenance cost | **ABI coupling** between the runtime and grammar builds is the main risk (E-26). Mitigated by an exact pin, a hash manifest, golden tests, and spike S2. |
| Fit | **Used for all languages** for outline, spans, `spanHash`, `bodyFingerprint` and fast change detection. |

### 2.2 Language Server Protocol

| Aspect | Assessment |
|---|---|
| Go to definition / find references | Exact where the server is good, but **per-position requests**. Whole-repo indexing means O(symbols) round trips, so it is slow. CodeForge caps LSP to changed files (≈20 files) for this reason (E-23 context). |
| Workspace symbols | Query-based and fuzzy. Not an enumeration API. |
| Semantic information | Hover and semantic tokens are presentation-oriented, not a graph export. |
| Cross-language | Each language needs its own server, with different capability coverage. Some servers execute project code (plugins, build-system integration). |
| Fit | **[DEF] Generic `LspResolver`** for future languages without a batch indexer. **In the extension**, VS Code's own providers (`vscode.executeDocumentSymbolProvider`) are used for *navigation cross-checks* (VSCODE_EXTENSION_DESIGN §6). That is not indexing. |

### 2.3 TypeScript compiler API

ADR-0016: chosen for TS/JS semantics. It builds a `Program` per `tsconfig` and walks the AST with the `TypeChecker` to resolve:

- imports (module resolution honoring `paths`, `baseUrl`, `exports`);
- references (identifier → declaration symbol);
- static call edges;
- `extends`/`implements` and type references.

It is batch-efficient, deterministic and exact (L3). Its risks are memory use on very large projects and API changes with TS 7 (R-03).

### 2.4 SCIP / LSIF

[Fact] SCIP has broad indexer coverage (E-15). CIE uses it as an optional, user-authorized importer (ADR-0011) that lifts Python, and later Dart, to L3 references. LSIF is not pursued.

### 2.5 Static analysis limits (all languages)

| Construct | Handling |
|---|---|
| Dynamic import / `require(expr)` with a non-literal argument | Edge to an `unresolved` node with the raw expression text. Status `unknown`. (SY-006) |
| Reflection (`obj[name]()`, Python `getattr`, `importlib.import_module(var)`) | Not resolved. The call site is recorded as `unresolved_call`. |
| Dependency injection (Nest/Angular decorators, `inversify`, Python `injector`) | L1 pattern detection (decorator names, `@Injectable`, constructor parameter types). Edges are emitted as `inferred` `injects` with producer `heuristic:di-<framework>`. Never `verified`. |
| Virtual dispatch / interface calls | TS: the call edge goes to the declared method (exact), plus `may_dispatch_to` edges for known implementers (inferred). Python: name-based candidate edges (inferred). |
| Monkey-patching, `eval`, code generation | Out of scope; recorded nowhere. Flow traces state "evidence incomplete" when they reach unresolved calls (KNOWLEDGE_GRAPH_DESIGN §8.7). |
| Generated code (`dist/`, `*.generated.ts`) | Excluded by default ignore rules. Configurable. |

## 3. Language support priorities

| Priority | Language | MVP? | Plan |
|---|---|---|---|
| 1 | TypeScript / JavaScript (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) | **Yes, deep** | tree-sitter (L1) + TS compiler API (L3). JS files are resolved through `allowJs` programs or a synthesized inferred project. |
| 2 | Python (`.py .pyi`) | **Yes, through the adapter** | tree-sitter (L1) + `PythonImportResolver` (L2). SCIP import later (ADR-0011). |
| 3 | Dart | No ([DEF]) | tree-sitter-dart + optional `scip-dart` import |
| later | Java/Kotlin, Go, Rust, C# | No | SCIP importer or generic LSP resolver |

## 4. Language adapter abstraction

There are two ports, because there are two concrete granularities: per-file extraction is pure and parallelizable, while project resolution is cross-file and stateful.

```ts
// @cie/core/code-intelligence/application/ports.ts (specification sketch)

export type LanguageId = 'ts' | 'tsx' | 'js' | 'py' | (string & { readonly __lang: unique symbol });
export type Fidelity = 'L0' | 'L1' | 'L2' | 'L3';
export type Capability =
  | 'symbols' | 'imports' | 'references' | 'calls'
  | 'typeRelations' | 'di' | 'docstrings';

export interface CapabilityProfile {
  readonly language: LanguageId;
  readonly fidelity: Readonly<Record<Capability, Fidelity>>;
}

export interface ProducerRef {
  readonly adapterId: string;     // 'treesitter' | 'lang-ts' | 'lang-python' | 'scip'
  readonly adapterVersion: string;
  readonly toolVersion: string;   // e.g. 'web-tree-sitter@0.27.1+tree-sitter-python@0.25.0'
}

/** Pure, per-file. The same bytes and the same producer version always give the same output (SY-001). */
export interface FileExtractor {
  readonly producer: ProducerRef;
  supports(lang: LanguageId): boolean;
  profile(lang: LanguageId): CapabilityProfile;
  extractFile(input: FileInput, signal: CancellationSignal): Promise<FileExtraction>;  // shared-kernel type
}

export interface FileInput {
  readonly path: CanonicalPath;
  readonly language: LanguageId;
  readonly content: Uint8Array;   // exact bytes; spans and hashes are computed from these
  readonly contentHash: ContentHash;
}

export interface FileExtraction {
  readonly path: CanonicalPath;
  readonly contentHash: ContentHash;
  readonly producer: ProducerRef;
  readonly symbols: readonly ExtractedSymbol[];       // qualifiedName, kind, range, spanHash, bodyFingerprint, exported, doc
  readonly imports: readonly ExtractedImport[];       // raw specifier, range, isDynamic, isTypeOnly
  readonly diagnostics: readonly ExtractionDiagnostic[]; // e.g. parse errors (partial trees still yield symbols)
}

/** Cross-file and stateful. Resolves extracted facts into edges with precision. */
export interface ProjectResolver {
  readonly producer: ProducerRef;
  supports(lang: LanguageId): boolean;
  profile(lang: LanguageId): CapabilityProfile;
  /** Called with the full set (full index) or the affected set (incremental). */
  resolve(input: ProjectInput, signal: CancellationSignal): Promise<ProjectResolution>;
}

export interface ProjectResolution {
  readonly edges: readonly ResolvedEdge[];        // type, from, to | unresolved(raw), precision, evidence locator
  readonly projectsDiscovered: readonly ProjectDescriptor[]; // tsconfig roots, Python source roots
  readonly affectedFiles?: readonly CanonicalPath[];          // incremental: dependents to re-resolve
}
```

**Implemented (Phase 02, P02-03/04)** in `packages/core/src/code-intelligence/`, with these refinements of the sketch:
- `supports(lang)` and `profile(lang)` become a `profiles` list that the registry validates up front;
- `extractFile` and `resolve` return `Result`s;
- `producer` is a `ProducerIdentity`, and each fact carries a `ProducerRef` with the fidelity of its capability (C-12);
- `ProjectInput` is `{manifest, extractions, fs}`;
- resolved edges are `StructuralEdge`s built by `createImportEdge` (SY-006).

**Registration.** The composition root registers adapters. `LanguageRegistry` (code-intelligence application) maps extension → language → (extractor, resolver[]). When several resolvers apply, they are ordered by fidelity, and the higher-fidelity resolver's edges supersede the lower one's for the same `(from, type, site)`.

**Adding a language** needs:
1. A grammar `.wasm` plus a query file (L1).
2. Optionally a resolver.
3. Golden fixtures.
4. A capability-profile entry.

No core changes are required. FF-DAT-006 golden tests gate this.

## 5. Capability matrix (MVP)

| Capability | TS/TSX | JS | Python | Dart (DEF) |
|---|---|---|---|---|
| Symbols (outline, spans, kinds) | L3 (tree-sitter + compiler cross-check) | L3 | **L1** | L1 (planned) |
| Docstrings / JSDoc | L1 | L1 | L1 | L1 |
| Imports → file | L3 (module resolution) | L3 (with `allowJs`), L2 for untyped `require` | **L2**: source-root heuristics (`src/` layout, package dirs, `__init__.py`, relative imports exact within the package) | L2 |
| Imports → symbol | L3 | L3 / L2 | **L2** (`from x import y` → symbol `y` in the resolved module, if defined) | L2 |
| References | L3 | L3 / L2 | **L2** (scope-aware name binding inside a file is exact; cross-module binding goes through import maps, recorded as heuristic) | L0 → L3 via SCIP |
| Calls (static) | L3 | L3 / L2 | **L2** | L0 |
| Type relations (`extends`, `implements`, base classes) | L3 | L3 (class `extends`) | **L2** (base-class names resolved via imports) | L1 |
| DI | L2 (heuristic) | L2 | L0 | L0 |
| Dynamic / reflective constructs | `unknown` | `unknown` | `unknown` | `unknown` |

**Where Python is lower than TS:** symbols (L1 vs L3), imports (L2 vs L3), references, calls and type relations (L2 vs L3), and DI (L0 vs L2). The Python heuristic resolver is still **deterministic**: identical inputs give identical edges. Its edges are labeled `inferred` because they are not proven.

## 6. Extraction pipeline details

1. **Read bytes once.** Compute `contentHash` and detect the encoding. UTF-8 is expected; other encodings are decoded per BOM or else skipped with a diagnostic. All spans are computed over the decoded text, and `spanHash` is computed over the UTF-8 encoding of the span text, so it is consistent across platforms.
   Precise rules (Phase 02, implemented in `adapters/treesitter/decode.ts` and `core/code-intelligence/domain/source-text.ts`):
   - A UTF-8 BOM, or a UTF-16LE/BE BOM, selects the encoding. The BOM is not part of the decoded text, so it never counts towards columns or span hashes.
   - Invalid input fails with `EXTRACTION_UNDECODABLE`; it is never replaced with U+FFFD.
   - Lines end at `\r\n`, `\n` or `\r` (LSP). Columns are UTF-16 code units. A terminator belongs to the line it ends.
   - `SourceText` is the single definition of `text(file, range)`. Extractors map parser offsets to ranges with it, and the SY-003 validator (`spanViolations`) maps ranges back to text with it.
   - The publish-time span check (P03-02) decodes in core with `decodeForSpanCheck`: the same BOM rules, and the same text as the extractors on any input they accept. `tests/invariants/sy/sy-003.spec.ts` checks this against an independent oracle, UTF-16 included.
2. **Normalize line endings for fingerprints only.** `spanHash` uses the exact span text, while `bodyFingerprint` uses a token stream with whitespace and comments dropped and the symbol's own name masked.
3. **Parse errors.** Tree-sitter still produces a partial tree. Symbols from `ERROR` regions are dropped, a diagnostic is recorded, and the file stays indexed.
4. **TS projects.**
   - Discover all `tsconfig*.json` files that are not excluded.
   - Files not covered by any tsconfig go into a synthesized inferred project (`allowJs`, `checkJs: false`).
   - Build programs sequentially and release each one after resolution. `BuilderProgram` is used for incremental runs in Phase 05.
   - Plugins are never enabled (A-06).
5. **Python roots.** Configured `python.roots`, otherwise detected (`src/` and top-level package dirs). Virtualenvs and `site-packages` are excluded. External imports resolve to `ext:pypi:<name>` nodes (L2, no symbols).
   **Implemented (Phase 02, `adapters/lang-python`):**
   - Roots are detected; a `python.roots` setting does not exist yet. The detected roots are: the workspace root; `src/` when it holds Python files; every directory with `pyproject.toml`, `setup.py` or `setup.cfg`, plus its `src/`.
   - For a given file, the roots that contain it are searched first, deepest first.
   - Lookup follows FileFinder order: package before module, `.py` before `.pyi`.
   - A local module shadows the standard library.
   - Standard-library imports become `ext:python:<top>`, using a fixed list (CPython 3.14 plus modules removed in 3.12/3.13).
   - Third-party imports become `ext:pypi:<top-level import name>`.
   - Namespace packages without a module file, missing relative targets and non-literal dynamic imports are unresolved.
   - The capability matrix says relative imports are "exact within the package". They are still recorded as `heuristic`, because the resolver declares imports at L2 and SY-006 caps its precision. Splitting relative imports into their own capability is a possible refinement.
6. **External dependencies (TS).** Imports resolving into `node_modules` produce `ext:npm:<name>` nodes (contradiction log C-13) plus exact edges to the package node. Symbols inside dependencies are not indexed in the MVP. [Proposal] Declaration-level indexing of dependencies is [DEF].

## 7. Grammar and adapter maintenance

| Risk | Control |
|---|---|
| Grammar version bump changes node types | CIE-owned queries plus golden fixtures. A bump PR must update the lock manifest (ADR-0010). |
| ABI mismatch | Spike S2. Fallback: vendored builds (ADR-0010 option C). |
| TypeScript major upgrade | `lang-ts` pins `typescript`. Upgrades go through golden fixtures. TS 7 is assessed in its own ADR (R-03). |
| Heuristic drift (Python) | Precision and recall against `scip-python` ground truth on the benchmark fixtures (BENCHMARK_STRATEGY §5) |
