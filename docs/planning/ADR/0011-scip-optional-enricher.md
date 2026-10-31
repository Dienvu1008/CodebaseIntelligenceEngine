# ADR-0011: SCIP (and LSIF) as an Optional Precise-Reference Enricher

- **Status:** Accepted (scheduled post-MVP: Phase 08+)
- **Date:** 2026-10-31
- **Related:** DEC-08, FR-028, ADR-0006, ADR-0016

## Context

- [Fact] SCIP is a Protobuf index format with TypeScript bindings. Indexers exist for TS/JS, Python, Dart, Java, Rust, C/C++, Ruby, C# and PHP (E-15).
- [Fact] `scip-typescript` 0.6.0 needs Node ≥22.23.4 and bundles TypeScript ^6 (E-16).
- [Fact] `scip-python` needs Python 3.10+ and **invokes pip** for environment discovery (E-17). That counts as executing tooling in the user's environment.
- LSIF is SCIP's predecessor. [Assumption] It is effectively superseded by SCIP for new tooling, so LSIF is not considered further.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| SCIP as the core extraction path | One format for many languages; exact references | Batch-only (whole project); external processes; slow for incremental updates; environment-dependent (pip) |
| **SCIP as an optional importer** | Upgrades Python and future languages to L3 references where the user opts in; the core stays self-contained | Two sources of truth to reconcile |
| No SCIP | Simplest | Python stays at L2 forever; Dart support costs more |

## Decision

1. SCIP is an **optional import adapter**: `ScipImportAdapter` implements `ProjectResolver` (see CODE_INTELLIGENCE_STRATEGY §4).
2. CIE **never runs indexers implicitly**. The user either runs the indexer themselves and points CIE at an `index.scip` file, or explicitly enables `enrichers.scip.run` with a fixed command template. Running tooling stays a user-authorized action (SEC-002 exception register).
3. **Reconciliation.**
   - SCIP occurrences are mapped to CIE symbols via (path, range) overlap with the tree-sitter span.
   - When the SCIP index's source hashes match the current file hashes, edges are recorded with evidence kind `scip` and status `verified` (L3).
   - SCIP data for changed files becomes `stale` until it is re-imported.
4. **Target languages:** Python first, then Dart (DEF, ADR-0006).

## Consequences

- MVP scope is unaffected.
- A clear upgrade path for exact references exists.

## Evidence

E-15, E-16, E-17.
