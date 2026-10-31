# Architecture Fitness Functions

> Status: Baseline v0.1 · Related: [DEPENDENCY_RULES](DEPENDENCY_RULES.md), [BENCHMARK_STRATEGY](BENCHMARK_STRATEGY.md), ADR-0012
> Machine-readable register: `governance/fitness.yaml`, a Phase 00 deliverable. The schema mirrors the table in §3.

## 1. Tool evaluation

| Tool | Strengths | Limits | Role in CIE |
|---|---|---|---|
| **dependency-cruiser** | Path-regex rules over the real module graph; understands TS path resolution; `no-circular`; package-level and folder-level rules; JSON/HTML reports; proven in CodeForge (E-22) | Not good at "only via `public.ts`" semantics without careful regexes; no type-level rules | **Primary** for FF-DEP-* and FF-BND-* |
| **ESLint `no-restricted-imports`** (flat config, per-glob overrides) | Instant editor feedback; simple bans on module names | Pattern-based only; no transitive analysis | **Secondary**: fast feedback duplicates of the critical bans (`vscode`, `better-sqlite3`, `@codeforge/*`, `node:*` in core) |
| **ArchUnitTS** (`archunit` 2.5.4, E-12) | Fluent architecture tests inside Vitest; metrics (coupling, cohesion, LCOM); cycle detection | Single maintainer (E-12), so there is bus-factor risk | **Not adopted** (OQ-10, decided in Phase 00). `dependency-cruiser --metrics` already reports Ca, Ce and instability per module and folder (`npm run metrics`), which covers FF-CPX-002 without a single-maintainer dependency. Revisit if LCOM/cohesion metrics become necessary. |
| **Vitest** | Runs invariant, contract, data-integrity and type-level tests (`expectTypeOf`) | — | **Primary** for FF-DAT-* and type-level checks |
| **TypeScript type-level constraints** | Branded IDs, capability tokens, required bound parameters, `exactOptionalPropertyTypes` | Only as strong as `any` discipline (lint `no-explicit-any` in core) | **Primary** for PV-002, AI-002, KG-004 |
| **Custom scripts** (`scripts/check-*.mjs`) | Governance-specific checks (YAML↔Markdown parity, allow-lists, test presence) | Must be maintained | **Primary** for governance fitness |

## 2. Execution model

| CI job | Trigger | Runs | Blocking? |
|---|---|---|---|
| `governance` | every PR | `node scripts/check-governance.mjs` (schema, test presence, no-removal, md↔yaml parity) | Yes |
| `dependency-direction` | every PR | `npm run lint` + `npm run depcruise` | Yes |
| `test` | every PR, Windows + Linux, Node 24 and 26 | `npm run typecheck && npm test` (includes `tests/fitness`, `tests/invariants`) | Yes |
| `contracts` | every PR (from Phase 06) | `npm run test:contracts` | Yes |
| `adversarial` | every PR (from Phase 01) | `npm run test:adversarial` | Yes |
| `bench-smoke` | every PR (from Phase 01) | Small fixture, 1 run, sanity only (no thresholds) | No (report) |
| `bench-nightly` | nightly + manual | Full tier matrix (BENCHMARK_STRATEGY) | Advisory until baselines exist; regression-blocking for the MVP gate metrics after Phase 05 |

## 3. Fitness function register

### 3.1 Dependency fitness

| ID | Rule | Tool | Phase | Blocking |
|---|---|---|---|---|
| FF-DEP-001 | No circular dependencies (module and package level) | depcruise `no-circular` | 00 | Yes |
| FF-DEP-002 | Domain → Infrastructure forbidden: `packages/core/**` imports nothing outside `packages/core` (no npm, no `node:*`) | depcruise + ESLint | 00 | Yes |
| FF-DEP-003 | No `vscode` import outside `packages/vscode-extension/src/host` | depcruise + ESLint | 00 | Yes |
| FF-DEP-004 | No `@codeforge/*` and no path containing `CodeForge` anywhere | depcruise + ESLint + `check-governance` scan of all `package.json` files | 00 | Yes |
| FF-DEP-005 | UI/build deps (`react`, `vite`, `esbuild`, `markdown-it`, `dompurify`) only in `packages/vscode-extension` | depcruise + manifest scan | 00 | Yes |
| FF-DEP-006 | `@cie/protocol` has zero dependencies (manifest and imports) | manifest scan + depcruise | 00 | Yes |
| FF-DEP-007 | `node:child_process` only in `adapters/process` and `packages/client` | depcruise | 00 | Yes |
| FF-DEP-008 | Third-party allow-list per adapter subfolder (DEPENDENCY_RULES §4 A2) | depcruise | 01 | Yes |

### 3.2 Boundary fitness

| ID | Rule | Tool | Phase | Blocking |
|---|---|---|---|---|
| FF-BND-001 | Cross-context imports in core only via `<ctx>/public.ts` (C3) | depcruise | 00 | Yes |
| FF-BND-002 | Domain does not import application (C4). Context order is acyclic (C5). | depcruise | 00 | Yes |
| FF-BND-003 | Raw SQL and table access only in `adapters/sqlite`; all reads take a pinned `RevisionSeq` (ADR-0015) | depcruise (imports) + Vitest (repository API signature test) | 01 | Yes |
| FF-BND-004 | Transport adapters (JSON-RPC, MCP, CLI) call only `ProtocolHandler`, never core use cases directly. The contract suite runs identically through JSON-RPC and MCP. | depcruise + contract tests | 06 / 09 | Yes |
| FF-BND-005 | `adapters/llm-*` and InferenceIntake cannot import `knowledge/domain/verification` (C8) | depcruise | 03 | Yes |
| FF-BND-006 | Public API snapshot: `@cie/protocol` declaration output diffed against the committed snapshot; breaking diff needs a major bump (API-001) | `tsc --declaration` + snapshot test | 06 (pre-1.0 advisory), 09 (blocking) | Yes from 09 |
| FF-BND-007 | Package `exports` maps prevent deep imports | Vitest (resolve attempts) | 00 | Yes |
| FF-BND-008 | The Webview bundle imports nothing from `src/host`, and the host imports nothing from `webview/` except `shared/messages.ts` | depcruise | 06 | Yes |

### 3.3 Complexity fitness

These are **calibrated thresholds, not performance targets**. Phase 00 sets them to the values below as [Proposal] starting points. Each one becomes a ratchet: a value may only be tightened, never loosened, without an ADR.

| ID | Rule | Tool | Initial setting | Blocking |
|---|---|---|---|---|
| FF-CPX-001 | God-object guard: per module, ≤ 15 exported symbols, ≤ 400 lines (excluding tests and generated files), cyclomatic complexity ≤ 15 per function | ESLint `max-lines`, `complexity`; custom export counter | warn in 00–02, **error** from 03 | From 03 |
| FF-CPX-002 | Coupling and cohesion monitoring: instability `I = Ce/(Ca+Ce)` per context. Domain contexts trend toward stable (low I). Report fan-in and fan-out. | depcruise metrics JSON → `scripts/report-coupling.mjs` (or ArchUnitTS) | report only | No (trend reviewed at each phase sign-off) |
| FF-CPX-003 | Max context size: a context exceeding a set number of modules triggers a split review. The number is set after Phase 03 from observed sizes. | custom | report | No |
| FF-CPX-004 | Shared-kernel allow-list (C6) and the ban on `utils`/`helpers`/`common`/`misc` folders (C7) | `check-governance` | — | Yes (00) |
| FF-CPX-005 | No `any` and no non-null `!` in `packages/core` | ESLint `@typescript-eslint/no-explicit-any`, `no-non-null-assertion` | error | Yes (00) |

### 3.4 Data integrity fitness

| ID | Rule | Tool | Phase | Blocking |
|---|---|---|---|---|
| FF-DAT-001 | Referential integrity: `PRAGMA foreign_keys = ON` asserted at open; `PRAGMA foreign_key_check` returns empty after indexing every golden fixture | Vitest | 01 | Yes |
| FF-DAT-002 | Workspace isolation: two workspaces indexed in the same test process never cross-read (WS-003); a store with a mismatched `meta.workspace_id` is refused | Vitest | 01 | Yes |
| FF-DAT-003 | Graph consistency: `RevisionValidator` passes on every golden fixture; interval-aware dangling-edge query returns 0 (KG-001) | Vitest | 02 | Yes |
| FF-DAT-004 | Revision consistency: a revision digest (ordered hash of visible rows) at seq S is unchanged after later revisions publish (SN-007); concurrent reader sees no staging rows (SN-003) | Vitest | 01 | Yes |
| FF-DAT-005 | Migration compatibility: `state.db` migrates from every released schema fixture (`tests/migration/fixtures/state-vN.db`); `index.db` schema mismatch triggers a rebuild, not a failure | Vitest | 01 (framework), every schema change | Yes |
| FF-DAT-006 | Determinism: indexing the same fixture twice, and on Windows vs Linux, yields identical `cie export --format json` bytes (NFR-023, WS-004) | Vitest + cross-platform job | 02 | Yes |
| FF-DAT-007 | Governance parity: every ID in `DOMAIN_INVARIANTS.md` appears in `invariants.yaml` and vice versa | `check-governance` | 00 | Yes |

### 3.5 Performance fitness

Methodology, fixtures and target-setting rules are in [BENCHMARK_STRATEGY](BENCHMARK_STRATEGY.md). **No numeric thresholds are set here** (NFR-066).

| ID | Measure | Gate type | Phase introduced |
|---|---|---|---|
| FF-PRF-001 | Incremental efficiency: work for a single-file edit is proportional to the affected set (files re-parsed, rows written), not to repo size | **Structural assertion** (counts, not time): editing 1 file re-parses exactly the changed file plus declared dependents | 05 (blocking, since it is count-based) |
| FF-PRF-002 | Memory: peak RSS during a full index, per tier | Regression vs baseline | 05 (advisory → blocking after baseline) |
| FF-PRF-003 | Query latency p50/p95/p99 per method | Regression vs baseline | 06 |
| FF-PRF-004 | Bounded queries: no query plan performs an unbounded scan. `EXPLAIN QUERY PLAN` tests assert index usage for each repository method. | **Structural assertion** | 03 (blocking) |
| FF-PRF-005 | Large-repo scalability: slope of index time and memory vs file count on the synthetic generator | Trend report | post-MVP (DEF) |
| FF-PRF-006 | Full re-index recovery: time from corrupted or deleted `index.db` to a published revision, plus crash-recovery correctness (SN-005) | Correctness blocking (01); time regression vs baseline (05) | 01 / 05 |
| FF-PRF-007 | Extension activation time and Webview bundle size | Regression vs baseline | 06 |

## 4. Draft dependency-cruiser rule set (specification)

This block specifies the rules for Phase 00. It is **not** a live config file.

> **Implemented in Phase 00** as `/.dependency-cruiser.cjs`. Differences from this draft:
> - FF-DEP-002 has **no type-only exception**. The core imports nothing outside itself, not even types, which keeps third-party types out of the ACL.
> - Additional rules split out the C5/C6 boundaries: FF-BND-001b (shared kernel is a leaf), FF-BND-002c (context order) and FF-BND-002d (synchronization never imports query).
> - npm-package rules match both `node_modules/<pkg>/` and an unresolved bare `<pkg>`, so packages that are not installed (e.g. `vscode`) are still caught.
> - `enhancedResolveOptions.exportsFields: ['exports']` must be explicit. Without it depcruise ignores package exports maps (found in Phase 00).
> - The group back-reference `$1` in `to.pathNot` works in dependency-cruiser 18.7.0, which resolves the assumption noted under the block.

```js
// .dependency-cruiser.cjs (DRAFT, Phase 00 to implement and test against intentionally violating fixtures)
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    { name: 'FF-DEP-001-no-circular', severity: 'error', from: {}, to: { circular: true } },

    { name: 'FF-DEP-002-core-is-pure', severity: 'error',
      from: { path: '^packages/core/src' },
      to:   { pathNot: '^packages/core/src', dependencyTypesNot: ['type-only'] } },

    { name: 'FF-DEP-002b-core-no-node-builtins', severity: 'error',
      from: { path: '^packages/(core|protocol)/src' },
      to:   { dependencyTypes: ['core'] } },

    { name: 'FF-DEP-003-vscode-only-in-host', severity: 'error',
      from: { pathNot: '^packages/vscode-extension/src/host' },
      to:   { path: '^vscode$' } },

    { name: 'FF-DEP-004-no-codeforge', severity: 'error',
      from: {}, to: { path: '(@codeforge/|CodeForge)' } },

    { name: 'FF-DEP-005-ui-build-deps-confined', severity: 'error',
      from: { pathNot: '^packages/vscode-extension/' },
      to:   { path: 'node_modules/(react|react-dom|vite|esbuild|markdown-it|dompurify)/' } },

    { name: 'FF-DEP-006-protocol-is-leaf', severity: 'error',
      from: { path: '^packages/protocol/src' },
      to:   { pathNot: '^packages/protocol/src' } },

    { name: 'FF-DEP-007-child-process-confined', severity: 'error',
      from: { pathNot: '^packages/(adapters/src/process|client/src)' },
      to:   { path: '^(node:)?child_process$' } },

    { name: 'FF-BND-001-cross-context-via-public', severity: 'error',
      from: { path: '^packages/core/src/([^/]+)/' },
      to:   { path: '^packages/core/src/([^/]+)/(?!public\\.ts$)',
              pathNot: ['^packages/core/src/$1/', '^packages/core/src/shared-kernel/'] } },

    { name: 'FF-BND-002-domain-not-application', severity: 'error',
      from: { path: '^packages/core/src/[^/]+/domain/' },
      to:   { path: '^packages/core/src/[^/]+/application/' } },

    { name: 'FF-BND-002b-no-upstream-to-sync-or-query', severity: 'error',
      from: { path: '^packages/core/src/(workspace|code-intelligence|knowledge|documentation)/' },
      to:   { path: '^packages/core/src/(synchronization|query)/' } },

    { name: 'FF-BND-005-llm-cannot-verify', severity: 'error',
      from: { path: '^packages/(adapters/src/llm-|core/src/knowledge/application/inference)' },
      to:   { path: '^packages/core/src/knowledge/domain/verification/' } },

    { name: 'FF-DEP-008-sqlite-confined', severity: 'error',
      from: { pathNot: '^packages/adapters/src/sqlite/' },
      to:   { path: 'node_modules/better-sqlite3/' } },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: { conditionNames: ['import', 'types', 'node'] },
  },
};
```

Note on FF-BND-001: dependency-cruiser supports group back-references (`$1`) in `to.path`/`pathNot`. [Assumption: verify in Phase 00 against the installed version. If unsupported, generate one rule per context.]

**Rule self-tests.** Phase 00 adds `tests/fitness/fixtures/violations/*`, one intentionally violating file per rule, and a Vitest test that runs depcruise on them and expects every rule ID to fire. This proves the rules are not vacuous.

## 5. Initial fitness test specifications

| Test file | Asserts |
|---|---|
| `tests/fitness/depcruise-rules.spec.ts` | Each FF-DEP/FF-BND rule fires on its violation fixture, and the real tree has 0 violations |
| `tests/fitness/manifests.spec.ts` | `@cie/protocol` has no `dependencies`; no manifest references `@codeforge`; UI deps appear only in the extension; every package is `private: true` with license `UNLICENSED` until ADR-0013 |
| `tests/fitness/shared-kernel.spec.ts` | Files in `shared-kernel/` equal the allow-list; no `utils/helpers/common/misc` folders |
| `tests/fitness/exports.spec.ts` | Deep imports such as `@cie/core/src/knowledge/domain/...` fail to resolve |
| `tests/fitness/type-level.spec.ts` | `expectTypeOf`: `SymbolId` is not assignable from `string`; `markVerified` requires a `VerificationToken`; `GraphReadModel.traverse` requires `maxDepth` and `limit` |
| `tests/fitness/governance.spec.ts` | Runs `check-governance` in-process against good and bad YAML fixtures |
| `tests/fitness/query-plans.spec.ts` (Phase 03) | `EXPLAIN QUERY PLAN` for each repository statement contains no `SCAN` of hot tables without an index (FF-PRF-004) |
