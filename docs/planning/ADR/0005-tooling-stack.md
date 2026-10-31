# ADR-0005: Tooling Stack

- **Status:** Accepted (preference-level; changes need a superseding ADR)
- **Date:** 2026-10-31
- **Related:** DEC-09, NFR-050..055

## Context

The stakeholder stated these tooling preferences ([PREF]):

- npm workspaces, TypeScript strict ESM, Vitest, ESLint 9 and dependency-cruiser.
- React + TypeScript for the Webview, built with Vite.
- esbuild for the extension host.

The hard constraint ([HR]) is that UI and build-tool dependencies stay outside the core. Supporting facts:

- [Fact] CodeForge proves this stack works on Windows and Linux CI (E-20, E-22).
- [Fact] ESLint 10 and Vitest 3/4 exist in the ecosystem (E-02, E-10, A-08). The preference for ESLint 9 is kept, and the upgrade question is tracked as OQ-08.
- **Phase 00 pinning result (E-32).**
  - TypeScript is pinned to **6.0.3**, not the latest 7.0.2, because `typescript-eslint` 8.72.1 supports only `typescript <6.1.0`.
  - ESLint stays on 9.39.5 (OQ-08 resolved: `typescript-eslint` supports both 9 and 10, so there is no forcing reason to move).
  - Vitest is 5.0.5, and `js-yaml` 5.5.0 ships its own types.
  - The full list is in `governance/phase_00_checklist.yaml` → `pinned_versions`.

## Options considered

| Area | Chosen | Alternatives | Why |
|---|---|---|---|
| Package manager | npm workspaces | pnpm, yarn | Preference; zero extra install; CodeForge parity for contributors |
| Language | TS strict ESM, `module`/`moduleResolution: NodeNext`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax` | CJS | ESM is the ecosystem direction; strict flags catch the index and undefined bugs that matter for graph code |
| Build (libraries) | `tsc --build` with project references | tsup | No bundling needed for Node packages; references enforce the package graph |
| Tests | Vitest (version pinned in Phase 00) | Jest, node:test | ESM-native; parallel; CodeForge parity |
| Lint | ESLint 9 flat config + typescript-eslint | Biome | `no-restricted-imports` is used as a fitness function |
| Architecture checks | dependency-cruiser (+ optional ArchUnitTS) | Nx boundaries | See [ARCHITECTURE_FITNESS](../ARCHITECTURE_FITNESS.md) |
| Webview UI | React + TS, Vite | Svelte, vanilla, Preact | Preference; ecosystem for accessible components. Bundle size is monitored (FF-PRF-007). |
| Extension host bundle | esbuild → CJS, `--external:vscode` | webpack | Fast; CodeForge precedent (E-27 context) |
| Schema validation (governance) | ajv (dev dependency only) | — | Validates `invariants.yaml` against its JSON Schema |

## Decision

Adopt the table above. Additional rules:

- Every dependency is pinned **exactly** (`.npmrc save-exact=true`) and the lockfile is committed.
- No UI or build dependency may appear in `packages/core`, `packages/protocol` or `packages/adapters`. FF-DEP-005 enforces this.
- Webview and extension-host dependencies live only in `packages/vscode-extension/package.json`.

## Consequences

- Phase 00 pins exact versions after an `npm view` check, and records them in the Phase 00 checklist.
- Moving to ESLint 10 is a superseding ADR.

## Evidence

E-02, E-10, E-20, E-22, A-08.
