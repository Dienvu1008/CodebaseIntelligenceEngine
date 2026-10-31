# ADR-0010: Tree-sitter via WASM; Version and ABI Strategy

- **Status:** Accepted (pending spike S2)
- **Date:** 2026-10-31
- **Related:** [CODE_INTELLIGENCE_STRATEGY](../CODE_INTELLIGENCE_STRATEGY.md), ADR-0006, A-01

## Context

- [Fact] CodeForge pins `web-tree-sitter@0.20.8` together with `tree-sitter-wasms@0.1.13`. Newer runtimes reject those grammars (E-26), so the ABI coupling is real.
- [Fact] `web-tree-sitter` is at 0.27.1 (E-02). Official grammar packages now ship their own `.wasm` files: `tree-sitter-typescript` 0.23.2 (E-03) and `tree-sitter-python` 0.25.0 (E-04).
- [Fact] The grammar packages also ship native prebuilds for the Node `tree-sitter` binding (E-03, E-04).

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **A. web-tree-sitter (WASM) + official grammar `.wasm` files** | No native compilation; identical behavior on all OSes; usable in-process later (ADR-0002) | WASM is slower than native [Assumption, measured in benchmarks]; ABI matching between runtime and grammar |
| B. Native `tree-sitter` Node binding + grammar prebuilds | Faster | A second native-module family with its own ABI; Electron-incompatible for future in-process use |
| C. Vendored grammars built by CIE with a pinned tree-sitter CLI | Full control of ABI | Build tooling (emscripten/docker) in CI; maintenance |

## Decision

**Option A**, with **Option C as the fallback** if spike S2 fails.

1. Pin the exact versions of `web-tree-sitter` and each grammar package. Record the grammar ABI version alongside the parser version in `ExtractionProducer.version` (SY-005).
2. Load grammar `.wasm` files from the resolved package directory (`createRequire(...).resolve('<pkg>/package.json')`). Verify each file's SHA-256 against a committed manifest (`adapters/treesitter/grammars.lock.json`).
3. Never use the grammar packages' native install scripts at runtime. Install with `--ignore-scripts` for the grammar packages, if the npm tooling allows it per package [Open OQ-09]. Otherwise accept that the scripts will run.
4. Keep extraction queries (`tags.scm`-style) as CIE-owned files with golden tests, because the upstream `queries/tags.scm` may change between versions.
5. Upgrades need a version bump in the lock manifest **and** green golden tests (FF-DAT-006).

**Spike S2 (Phase 02 entry):**
- Load the TS, TSX and Python `.wasm` in web-tree-sitter 0.27.1 on Node 24 and 26, Windows and Linux.
- If `tree-sitter-javascript` lacks `.wasm` (E-05), use the TSX/TypeScript grammar for JS, or vendor it.
- Record the result in this ADR.

## Consequences

- Grammar churn becomes visible through golden fixtures instead of silent behavior changes.
- Option C remains available, at an added CI cost.

## Evidence

E-02..E-06, E-26.
