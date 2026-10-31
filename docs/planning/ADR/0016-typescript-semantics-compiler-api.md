# ADR-0016: TypeScript Semantics via the TypeScript Compiler API (Not LSP) for the MVP

- **Status:** Accepted (re-check at Phase 02 against the TypeScript 6/7 API status)
- **Date:** 2026-10-31
- **Related:** ADR-0006, FR-022..023, [CODE_INTELLIGENCE_STRATEGY §3](../CODE_INTELLIGENCE_STRATEGY.md)

## Context

The brief offers tree-sitter plus the TS language service *or* a language server. Relevant facts:

- [Fact] CodeForge uses `typescript-language-server` over stdio, limited to changed files (≈20 files, 40 symbols per file), because LSP requests are per-position and slow in bulk (E-23 context).
- [Fact] TypeScript 6 exists: `scip-typescript` 0.6.0 depends on `typescript ^6.0.3` (E-16). A native TS 7 preview exists as `@typescript/native-preview` (E-10). [Assumption] The programmatic API of TS 7 may differ from the JS compiler API.
- [Fact] `scip-typescript` builds its index from the TS compiler API (E-15, E-16), which proves that batch extraction of exact references this way is feasible.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **A. TS compiler API in-process (Program, TypeChecker, `findReferences`-style traversal)** | Batch-efficient; deterministic; exact; no protocol overhead; no external process | Memory heavy on huge projects; API churn risk with TS 7 |
| B. typescript-language-server via LSP | Standard protocol; reusable for other languages | Per-position requests (slow for whole-repo indexing); external process; tsserver plugins could load project code (security) |
| C. scip-typescript as the primary path | Exact; standard output | Whole-project batch only; weak for incremental updates; external process |

## Decision

**Option A** for TS/JS semantics, isolated in `adapters/lang-ts`, which implements `ProjectResolver`.

- The `typescript` version is pinned exactly and is independent of the workspace's own TypeScript. [Proposal] Using the workspace's version is [Open] (OQ-05).
- Program construction never enables plugins, so tsserver plugins are not loaded (A-06, verified by an adversarial test in Phase 02).
- **Memory control:** one `Program` per tsconfig project, built and released sequentially. An incremental `BuilderProgram` is used for Phase 05 incremental indexing.
- **Generic LSP adapter: [DEF].** It is reserved for future languages that have an LSP server but no batch indexer.

## Phase 02 re-check (P02-02, 2026-10-31): decision re-confirmed

- [Fact, E-35] TypeScript 7.0 (Go port) went GA on 2026-07-08 **without a programmatic API**. The 7.0.2 package exports only `./unstable/*` entry points. TypeScript 7.1 introduces a new, different API: beta on 2026-10-20, not stable.
- [Fact, E-35] The latest 6.x is 6.0.3 (2026-04-16), and there has been no 6.x release since. It remains the JS compiler API that the ecosystem (typescript-eslint, ts-morph) depends on.
- **Decision:** `lang-ts` pins `typescript@6.0.3`, the same version as the dev toolchain, so there is one TypeScript in the lockfile. Option A stands.
- **Revisit trigger (R-03):** TS 7.1's API reaches a stable release, or 6.x is declared unsupported. Migration is confined to `adapters/lang-ts` behind `ProjectResolver`. The golden fixtures (P02-12) are the regression net for that switch.

## Phase 02 implementation (P02-06): import resolution

Implemented in `packages/adapters/src/lang-ts/` (`LangTsResolver`, a `ProjectResolver` for ts, tsx and js that declares imports at L3 and everything else at L0).

- **No Program yet.** Phase 02 needs module resolution only. It uses `ts.parseJsonConfigFileContent` (with `extends`, `include`, `exclude`, `files`) and `ts.resolveModuleName` with one `ModuleResolutionCache` per project. A `Program` or `TypeChecker` arrives with references in Phase 03. Until then nothing in lang-ts can load a plugin, and `compilerOptions.plugins` is also stripped from parsed options.
- **Snapshot-only host (`VirtualWorkspace`).** TypeScript never sees the real disk:
  - files and directories come from the manifest;
  - contents come only from `tsconfig*.json`, `jsconfig*.json` and `package.json`, read through the root-confined `FileSystem` port;
  - `node_modules` (ignored, never read) is emulated only for workspace packages: `…/node_modules/<name>/…` maps to the directory of the workspace package `<name>`. So monorepo imports, package `exports` and `extends` from a workspace package resolve as the package manager would link them, and the output depends only on the snapshot (WS-004).
- **Projects:** `tsconfig.json` / `jsconfig.json` files. A file belongs to the deepest config that lists it. Unlisted files go to an inferred project (`allowJs`, bundler resolution).
- **Classification and precision (SY-006):**

  | Specifier outcome | Edge |
  |---|---|
  | resolves to a workspace file in an MVP language | `imports` → module, exact |
  | resolves to another workspace file (`.json`, `.css`) | none, `IMPORT_TARGET_NOT_A_MODULE` diagnostic |
  | Node built-in (`node:*` or a bare built-in name) | `ext:node:<name>`, exact |
  | bare package, not a workspace package, not covered by `paths` | `ext:npm:<pkg>`: exact if an enclosing `package.json` declares it, heuristic otherwise |
  | anything else, or a non-literal specifier | `unresolved` |

  The built-in list is a fixed Node 24 snapshot, not `module.builtinModules`, so results do not depend on the Node version that runs the indexer.
- **Named bindings:** `imports_symbol` edges are heuristic. The target is the single exported top-level symbol of that name in the target's L1 extraction. Zero candidates (re-exports, barrels) or several (overloads) give an unresolved edge. Exact binding through the TypeChecker is Phase 03.
- **Resolution mode:** `import()` resolves as ESM. Other imports use the file's implied format (`getImpliedNodeFormatForFile`). `require()` in an ESM file is therefore resolved as ESM, which is a known approximation, because extraction does not record the import form.
- **Internal API dependency (risk):** `readDirectory` uses `ts.matchFiles`, which is internal to TypeScript, so that include/exclude globbing matches tsc exactly. It is guarded at startup with a clear error, and `typescript` is pinned. A TS upgrade must re-run the lang-ts tests.
- **A-06, resolution path verified:** `tests/adversarial/lang-ts-plugins.spec.ts`. The `Program` part of A-06 is re-verified in Phase 03 by extending the same test. Plugins declared in `tsconfig.json` and in an extended config, both as an installed package and as a workspace package, are not loaded. A positive control proves the canary fires when really required. CI matrix pending.

## Consequences

- **Phase 00 update (E-32):** TypeScript 7.0.2 (native) is now the npm `latest`, and CIE's toolchain pins 6.0.3. The Phase 02 entry must re-check this ADR: whether the TS 6 JS compiler API remains maintained, and what programmatic API TS 7 offers.
- A TS 7 migration may need adapter work. The `ProjectResolver` port isolates it, and the risk is tracked as R-03.
