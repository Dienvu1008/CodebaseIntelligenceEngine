# Phase 02 Sign-off: Multi-language Symbol Extraction

- **Status:** **Accepted** by the project owner on 2026-10-31. CI was green on the full matrix for the closing commit `02ee81c`, as reported by the owner. `main` was fast-forwarded per the branch workflow (IMPLEMENTATION_ROADMAP).
- **Date:** 2026-10-31
- **Branch:** `phase-02` (from `main` at `d1baa7a`)
- **Checklist:** [`governance/phase_02_checklist.yaml`](../../governance/phase_02_checklist.yaml), all 14 items done.

> **Before:** revisions of files and structure.
> **After:** every published revision also holds a code graph. It has symbols with verifiable spans and stable identities, imports with honest precision, and module, external and unresolved nodes, for TS, TSX, JS and Python. It is searchable (`cie dev symbols`), reported by capability (`cie dev status`), measured against the TypeScript compiler, and identical byte for byte on Windows and Linux.

## Phase gate

- [x] **Every Phase 02 invariant has a passing test.**
  - SY-001, SY-002, SY-003, SY-005, SY-006 and KG-001 have tests under `tests/invariants/`.
  - With `CIE_PHASE=3`, check-governance reports no `invariant-test-presence` errors.
  - SY-001, SY-003, SY-006, KG-001 and SY-002 were mutation-checked: each fails when the rule it guards is broken.
- [x] **Fitness functions activated:**
  - FF-DAT-003: graph consistency at every published seq on every golden fixture, with independent SQL and a damaged-copy self-test.
  - FF-DAT-006: `cie-export/2` byte-identical to committed goldens on all 7 fixtures, on all four CI cells.
  - FF-DEP-008b/c remain enforced: web-tree-sitter only in `adapters/treesitter`, the TypeScript runtime only in `adapters/lang-ts`.
- [x] **Acceptance criteria (roadmap):**
  - Golden equality holds on all fixtures: `xplat-basic`, `ts-basic`, `ts-monorepo`, `js-mixed`, `py-basic`, `py-src-layout`, `edge-cases`.
  - Symbol precision and recall are reported against the TS compiler for TS/JS, and against hand-verified ground truth for every fixture (the only oracle for Python). See the quality section below.
  - The capability matrix is exposed by `cie dev status` (`tests/integration/code-graph.spec.ts`).
- [x] **Benchmarks re-run with extraction, without thresholds:** B-01, B-02, B-10 and B-11 on Zod, Requests and CodeForge-v2 (reference), plus the CodeForge-v2 working tree (dogfood). See `benchmarks/results/2026-10-31-121499ea-*`.
- [x] **CI green on the closing commit** `02ee81c` (the one that bumps `governance/phase.yaml` to 3), and **owner approval** (2026-10-31).

## Commits

| Commit | Content |
|---|---|
| `5beff06`, `6ba7231` | Spike S2 and vendored tree-sitter grammars (OQ-09 option A); code-intelligence domain (SymbolIdentity, CapabilityProfile, FileExtraction, import edges with SY-006) |
| `8de069f` | FileExtractor and ProjectResolver ports; LanguageRegistry (authority over the Phase 01 extension map, golden-tested) |
| `8307466` | Tree-sitter L1 extractor (TS, TSX, JS, Python), SourceText, SY-003 |
| `e8a9c1a` | lang-ts import resolver over a snapshot-only host; A-06 adversarial test (resolution path) |
| `f832e60` | Python heuristic import resolver; `py-basic`, `py-src-layout` |
| `8b8e8e9` | Graph projection, `index.db` schema v3, mandatory graph staging, KG-001/SY-002/SY-005 validation, pipeline and runtime wiring |
| `1bd0367` | FTS5 symbol search (schema v4), `cie dev symbols` |
| `4564c10` | `cie-export/2`; FF-DAT-003 and FF-DAT-006 |
| `12c767f` | Four new golden fixtures with hand-verified ground truth; four extractor fixes and one pipeline fix |
| `121499e` | Quality report tooling; six extractor fixes found against the TypeScript compiler |
| `3e46428` | Quality report and benchmark results from a clean commit |
| `02ee81c` | Closing commit: this sign-off, the Phase 03 checklist, `phase.yaml` → 3 |
| *acceptance commit* | This status change only |

## Components delivered

- **Core (still pure):**
  - Code-intelligence domain:
    - `capability.ts`: LanguageId, Fidelity, CapabilityProfile, ProducerIdentity and ProducerRef, the precision rules.
    - `symbol-identity.ts`: `identifySymbols`, `parseSymbolId`, `encodeNameSegment`.
    - `file-extraction.ts`, including the `defaultExport` flag.
    - `import-edge.ts`: `createImportEdge`, `importEdgeViolations`.
    - `source-text.ts`: SourceText, `spanViolations`.
    - `graph-projection.ts`, `languages.ts`, `symbol-search.ts`.
  - Code-intelligence application: ports (`FileExtractor`, `ProjectResolver`, `CodeGraphReader`, `SymbolSearch`), `LanguageRegistry`.
  - Synchronization: `buildCodeGraph` in IndexService, with the stages `extracted` and `resolved`.
- **Adapters:**
  - `treesitter`: GrammarLoader (SHA-256 at first load, cached per process), TreeSitterExtractor, CIE-owned queries, decoding.
  - `lang-ts`: LangTsResolver, VirtualWorkspace, fixed Node built-ins list; `typescript@6.0.3`, loaded lazily.
  - `lang-python`: PythonImportResolver, fixed standard-library list.
  - `sqlite`: graph store and search store (schemas v3 and v4).
- **Runtime:** LanguageRegistry wiring (created on first use); `dev index` code statistics; `dev status` capability matrix; `dev symbols`; `dev export` → `cie-export/2`.
- **Artifacts and tooling:**
  - `packages/adapters/grammars/`: four `.wasm` files, licenses, `ATTRIBUTION.md`, `grammars.lock.json`.
  - `scripts/grammars/fetch.mjs` (with `--check`).
  - `scripts/quality/report.mjs` (`cie-quality-report/1`).
  - `cie-bench-result/2`.
- **Fixtures:** seven golden fixtures with `*.export.json` goldens and `*.truth.json` ground truth; `py-*.imports.json` resolver goldens.

## Decisions taken in this phase

| Decision | Reason | Where |
|---|---|---|
| Vendor the four grammar `.wasm` artifacts with a provenance lock, verified at first load (OQ-09 option A) | No install scripts, no unused native code, no network at build time, reviewable upgrades | ADR-0010 |
| `lang-ts` pins `typescript@6.0.3` | TS 7.0 has no programmatic API; 7.1's is beta | ADR-0016, E-35 |
| ProducerRef = ProducerIdentity + the fidelity of the capability behind each fact (C-12) | One adapter has different fidelities per capability | `capability.ts` |
| External ids `ext:<ecosystem>:<name>` (C-13); ecosystems `node` and `python` added for built-ins and the standard library | One id scheme; built-ins are not third-party packages | KNOWLEDGE_GRAPH_DESIGN §2 |
| Name segments are percent-encoded (`#items` → `%23items`), not mapped to placeholders | Every source name is representable and ids stay parseable; adopted before any id was persisted | ADR-0014 notes |
| Syntactic edges (`contains`, `defines`, `exports`) carry no precision (C-14) | Precision belongs to resolution; an L1 producer cannot claim `exact` | KNOWLEDGE_GRAPH_DESIGN §5 |
| No `Program` in Phase 02: config parsing plus `resolveModuleName` over a snapshot-only host | Import resolution needs nothing more; results depend only on the snapshot; no plugin can load | ADR-0016 |
| Python imports declared L2, including relative imports | SY-006 caps precision by declared fidelity; a separate capability would be needed for exact relative imports | CODE_INTELLIGENCE_STRATEGY §6.5 |
| Graph staging is a mandatory third step, even for an empty graph | A forgotten step can never look complete | `index-store.ts` |
| Resolver supersession applies between resolvers only | One resolver may emit several edges per site (Python package plus submodules) | `code-graph-build.ts` |
| FTS is head-only and maintained inside the publish transaction | Search moves with the head (SN-003); abandoned revisions never touch it | KNOWLEDGE_GRAPH_DESIGN §5 |
| `cie-export/2`; EXPORT_FORMAT E2 refined: paths NFC, source-derived strings verbatim | Normalizing identifiers could merge distinct symbols (ADR-0014) | EXPORT_FORMAT.md |
| An ERROR root does not drop the file's symbols | An unclosed block (a file being edited) erased every symbol of the file | `syntax.ts` |
| CLI-spawning test files use a 180 s timeout; other tests keep 30 s | Each process now loads grammars and the compiler; hangs elsewhere are still caught quickly | `tests/helpers/cli.ts` |

## Problems found by our own checks (and fixed)

- **Ground-truth review (P02-12)** found five defects:
  - members of parameter type literals were taken as properties;
  - `default` imports were never bound (fixed with the new `defaultExport` flag);
  - `require` bindings were recorded as constants;
  - members surfaced by error recovery appeared as orphans;
  - resolver supersession dropped Python submodule edges that shared an import site. The P02-07 goldens could not catch this, because they called the resolver directly; a pipeline regression test now covers it.
- **The TypeScript-compiler oracle (P02-13)** found six more:
  - object-literal methods were taken as symbols. This also caused false `~n` collisions with same-named interface members in Zod;
  - class overload signatures were lost. This was a regression introduced in P02-12;
  - parameter properties were missing (95 in CodeForge-v2);
  - variables in `namespace` and `declare global` were missing;
  - `declare const` was missing;
  - an ERROR root dropped every symbol of the file.
- **Mutation testing exposed two weak tests.**
  - The SY-001 "unique ids" property rarely generated collisions, so a broken disambiguator survived. The generator is now weighted towards collisions.
  - The FTS test did not notice stale rows, because reads re-check visibility. It now asserts that the index size equals the head's symbols.
- **Process errors, recorded honestly:**
  - One mutation check was read before `dist` was rebuilt, and gave a misleading result. Later checks always rebuild after restoring.
  - A first benchmark run was measured while Ollama held ~5 GB and the machine swapped (CV up to 0.99). It was discarded and re-run after a reboot. A per-row staging cost derived from that run (~180 µs) was wrong; the clean figure is ~30 µs.
- **Reviewing tree-sitter output against tsc** showed that the grammar returns an ERROR root for an unclosed trailing block, and for `using` as an identifier. A regression test pins this.

## Quality (symbols, `benchmarks/results/2026-10-31-121499ea-quality.json`)

| Workspace | vs TypeScript compiler (TS/TSX/JS) | vs hand-verified ground truth |
|---|---|---|
| Zod v4.6.7 | 7051 / 7051 · P 0.9989 · R 1 | — |
| CodeForge-v2 `d885bed0` | 6073 / 6073 · P 0.9997 · R 1 | — |
| Requests v2.34.2 | (no TS/JS) | — |
| 7 golden fixtures | P 1 · R 1 | symbols and imports P 1 · R 1; bindings R 0.5 on `js-mixed` (destructured `require`, documented gap) |

- **The residual extras are explained.**
  - Interfaces inside `declare module "…"` augmentations are a scope difference: the oracle does not count them.
  - Two locals in a CodeForge-v2 test file are surfaced by error recovery, because tree-sitter 0.23.2 cannot parse `using` as an identifier. This is accepted: it is the price of keeping that file's real declarations.
- **Oracle scope:**
  - It counts module-level declarations; class, interface, type-literal-alias, enum and namespace members, including parameter properties; and function and class declarations at any depth.
  - It counts no locals, parameters or object-literal members.
  - Files with syntax errors are listed and excluded, because tsc and tree-sitter recover from errors differently.

## Benchmarks (reference machine, clean commit `121499e`, B-02 warm full index, median)

| Fixture | Files extracted | Symbols | Edges | Wall time (Phase 01) | Peak RSS | index.db |
|---|---|---|---|---|---|---|
| Zod v4.6.7 | 523 | 7059 | 11348 | 4.16 s (0.89 s) | 236 MB | 21 MB |
| CodeForge-v2 (reference) | 530 | 6075 | 10343 | 3.67 s (0.82 s) | 211 MB | 22 MB |
| Requests v2.34.2 | 37 | 1007 | 1846 | 0.89 s (0.29 s) | 128 MB | 3.7 MB |

- **Stability:** CV ≤ 0.11 in every scenario, and every scenario is deterministic over the export bytes, so the code graph is included.
- **Zod B-02 split:**

  | Stage | Time |
  |---|---|
  | startup | 0.12 s |
  | enumerate | 0.65 s |
  | **extract** | **1.96 s** |
  | resolve | 0.26 s |
  | stage | 0.58 s (~30 µs per graph row) |
  | publish (incl. FTS) | 0.26 s |

- **Extraction dominates.** CodeForge-v2 extracts ~3 ms per file on the clean run.
- **Conditions:** IDE language servers were idle in the background (~25 % CPU). No thresholds (NFR-066).

## Honest self-review

- **SY-003 is not re-checked at publish.** `spanViolations` exists and is tested, but `validate()` cannot run it: the store has neither file contents nor line counts.
  - The span invariant rests on the extractor computing ranges and hashes from the same buffer, which SY-003's independent oracle tests on every encoding and line-ending case.
  - DOMAIN_INVARIANTS asks for a validator check as well. This is carried into Phase 03 (P03-02).
- **Symbols are L1 everywhere** (`dev status` says so). The TS compiler only resolves imports in this phase. `imports_symbol` is heuristic for every language: re-exports, barrels and overloads give unresolved bindings rather than guesses. Exact binding is P03-03.
- **A-06 is only partly verified:** the resolution path. The `Program` path arrives with references and is re-verified then (P03-01).
- **`ts.matchFiles` is internal TypeScript API,** used so include/exclude globbing matches tsc exactly. It is guarded at startup, and TypeScript is pinned.
- **Known approximations:**
  - `require()` inside an ESM file resolves in ESM mode;
  - Python `exports` follow the underscore convention (`__all__` is not evaluated);
  - Python source roots are detected (no `python.roots` setting yet);
  - CommonJS `module.exports` is not reflected in `exported`.
- **Ground truth was drafted from reviewed output and then corrected by hand.** This carries an anchoring risk. The TypeScript-compiler oracle exists to counter it, and it did find defects that the ground-truth review had missed.
- **The tsc oracle reuses `identifySymbols`.** An identity bug would be symmetric and invisible to it. Identity itself is covered by SY-001's property tests.
- **Startup cost:** every `dev index` process loads four grammars and, for TS/JS workspaces, the compiler (~0.1–0.5 s). It is paid per process, which matters for the CLI and much less for the long-running runtime of Phase 06.
- **Complexity warnings** were cleared as they appeared. The limit becomes an error in Phase 03 (P03-13).
- **CI status is reported by the owner** (the agent has no Actions access). Windows cells skip one test, the Linux-only non-portable-name case, as in Phase 01.

## Deferred (explicitly out of scope, or carried into Phase 03)

- References, calls, type relations, a `Program` per project and exact `imports_symbol` (Phase 03: P03-01, P03-03, P03-07, P03-08).
- The SY-003 publish-time span check (P03-02).
- `file:` nodes and directory → file `contains` edges (no consumer before the wiki, Phase 04).
- A `python.roots` setting, `__all__` evaluation, and a separate exact capability for Python relative imports.
- Lineage of symbols across revisions (SY-004, Phase 05) and incremental extraction (Phase 05).
- Performance targets and medium or large tiers (DEF). Extraction is the first optimization candidate.
- `npm audit`: 11 moderate, 0 high, 0 critical. This is the same dev-only `minimatch` chain as in Phases 00 and 01; nothing is shipped.

## Test progression

| Point | Tests |
|---|---|
| Phase 00 exit | 93 |
| Phase 01 exit | 274 on Windows plus 1 skipped; 275 on Linux (31 spec files) |
| Phase 02 exit | 460 plus 1 skipped locally on Windows (52 spec files): invariants, fitness, golden, ground truth, adversarial, integration, cross-platform, adapters, core. CI on `02ee81c` was reported green on all four cells; per-cell counts were not recorded. |
