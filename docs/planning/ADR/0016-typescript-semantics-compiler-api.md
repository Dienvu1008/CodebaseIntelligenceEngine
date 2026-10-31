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

## Consequences

- **Phase 00 update (E-32):** TypeScript 7.0.2 (native) is now the npm `latest`, and CIE's toolchain pins 6.0.3. The Phase 02 entry must re-check this ADR: whether the TS 6 JS compiler API remains maintained, and what programmatic API TS 7 offers.
- A TS 7 migration may need adapter work. The `ProjectResolver` port isolates it, and the risk is tracked as R-03.
