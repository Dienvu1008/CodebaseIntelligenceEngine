# Test Strategy

> Status: Baseline v0.1 · Related: ARCHITECTURE_FITNESS, DOMAIN_INVARIANTS, BENCHMARK_STRATEGY

## 1. Principles

1. **Invariants first.** Every invariant has exactly one owning test file (`tests/invariants/<prefix>/<id>.spec.ts`), and `check-governance` enforces its presence.
2. **Determinism.** No wall-clock time, randomness or network in tests:
   - `Clock` and `Hasher` are injected;
   - property tests use a fixed seed;
   - Vitest sequencing is deterministic, following the CodeForge precedent (E-20).
3. **Pure core, fast tests.** Domain and application tests use in-memory fakes of every port. SQLite adapter tests use real temporary DB files.
4. **No LLM in the default suite.** `llm-none` and a scripted `FakeLlmProvider` are used instead (AI-004).
5. **Cross-platform by default.** The full suite runs on Windows and Linux with Node 24 and 26 (ADR-0004).

## 2. Test layers

> **Phase 00 note:** package unit tests live in `packages/<pkg>/test/`, not in `src/**/__tests__`. Keeping them out of `src/` means test-only imports such as `vitest` never enter a package's compiled output or its purity rules (FF-DEP-002 applies to `packages/core/src/`).

| Layer | Location | Scope | Tools | Phase |
|---|---|---|---|---|
| Unit (domain) | `packages/core/test/**` | Aggregates, domain services (SymbolIdentity, SymbolMatcher, LinkResolver, SectionWriteGuard, PublishPolicy) | Vitest, fast-check (property-based) | 00+ |
| Application | `packages/core/test/**` | Use cases with fake ports | Vitest | 01+ |
| Adapter | `packages/adapters/test/**` | SQLite repositories (visibility filters, CAS, FKs), tree-sitter queries, TS resolver, Markdown parser, FS guard | Vitest + temp dirs | 01+ |
| Invariant | `tests/invariants/**` | One file per invariant ID | Vitest | per invariant phase |
| Fitness | `tests/fitness/**` | Architecture rules and their self-tests (ARCHITECTURE_FITNESS §5) | Vitest + depcruise | 00 |
| Golden fixture | `tests/golden/**` + `fixtures/**` | Extraction output, graph export and wiki generation snapshots per fixture repo | Vitest snapshot (JSON, sorted) | 02+ |
| Contract | `tests/contracts/**` | Protocol behavior over the in-process handler, JSON-RPC stdio and MCP | Vitest + spawned runtime | 06 / 09 |
| Adversarial | `tests/adversarial/**` | Paths, config, prompt injection, secrets, malformed markers, giant and binary files, ReDoS-like inputs | Vitest | 01+ |
| Crash / recovery | `tests/invariants/sn/sn-005.spec.ts` + `tests/recovery/**` | Kill points per pipeline stage (`CIE_TEST_KILL_AT=<stage>`) | Vitest + child process | 01 |
| Migration | `tests/migration/**` | `state.db` migration from every committed fixture version; `index.db` rebuild on mismatch | Vitest | 01+ |
| Cross-platform | `tests/cross-platform/**` | Path canonicalization vectors, CRLF/LF, case-insensitive FS, symlink behavior, golden byte-identity across OSes | Vitest on the CI matrix | 01+ |
| Extension host | `packages/vscode-extension/src/host/__tests__` | View models, message validation, navigation decision logic (pure) | Vitest | 06 |
| Extension integration | `packages/vscode-extension/test/` | Activation, command registration, runtime spawn, reveal flow | `@vscode/test-electron` (version pinned in Phase 06) | 06 |
| Webview | `packages/vscode-extension/webview/src/**/__tests__` | Components (BottomSheet focus trap, keyboard), Markdown sanitization | Vitest + Testing Library + axe-core (automated a11y checks, not a WCAG certification) | 06 |
| Benchmark | `benchmarks/` | BENCHMARK_STRATEGY | custom harness | 01+ |

## 3. Fixture repositories (`fixtures/`)

| Fixture | Purpose |
|---|---|
| `ts-basic` | Classes, functions, interfaces, enums, re-exports, `paths` aliases |
| `ts-monorepo` | Multiple tsconfigs, project references, package `exports` |
| `js-mixed` | CJS/ESM, `require`, dynamic import (literal and non-literal) |
| `py-basic` | Packages, relative imports, classes and inheritance, `__all__` |
| `py-src-layout` | `src/` layout, namespace packages, `importlib` (unresolved) |
| `edge-cases` | Unicode identifiers, very long lines, parse errors, BOM/CRLF, symlinks (incl. escaping), large file over the limit, binary |
| `wiki-basic` | Curated pages, generated sections, malformed markers, duplicate IDs, every link syntax |
| `drift-scripts` | Scripted edit sequences (edit, rename, move, delete, rename+edit) applied between revisions (DOCUMENTATION_MODEL §11) |

Each fixture has hand-verified **ground truth** (`fixtures/<name>/expected/*.json`) for symbols and edges. This ground truth is also used for the intelligence-quality metrics.

## 4. Key test designs

| Target | Design |
|---|---|
| SY-001 determinism | Property test over random identifier sets plus a re-run comparison on all fixtures |
| SY-004 lineage | Every `drift-scripts` step is checked against the expected classification table |
| SN-003 atomic visibility | A reader loop queries at head while a writer stages a large revision with artificial delay. The reader never sees staging rows. Then publish, and the reader sees all of them. |
| SN-002 CAS | Two staging revisions on the same base. The first publish succeeds and the second gets `PublishConflict`. |
| DOC-003 byte preservation | Property test over random Markdown (LF/CRLF/BOM, Unicode) with random generated sections. User bytes are compared before and after. |
| AI-001 | `FakeLlmProvider` returns fabricated paths, line numbers and unknown IDs. None of them is persisted. |
| SEC-005 | A workspace `cie.config.json` with `llm.endpoint` is rejected, and the runtime uses the user config only |
| WS-002 | Vector table of malicious paths per OS |

## 5. Coverage policy

Coverage is reported (v8) and not gated by percentage. [Proposal] The gates are invariants, fitness functions, golden fixtures and contracts, because percentage gates reward the wrong tests. Any core domain module below 80% line coverage is flagged in phase sign-off reviews.

## 6. Phase gate checklist (tests)

At each phase exit:
- All CRITICAL and HIGH invariants with `phase ≤ N` pass on Windows and Linux.
- Fitness functions are green.
- Golden snapshots have been reviewed. Snapshot updates require a reviewer note in the PR.
- Benchmark results are recorded, and the gate applies only where BENCHMARK_STRATEGY says so.
