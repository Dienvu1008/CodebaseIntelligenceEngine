# Phase 00 Sign-off: Architecture and Domain Baseline

- **Status:** **DRAFT.** Pending CI on the full matrix (checklist item P00-13).
- **Date:** 2026-10-31
- **Branch:** `phase-00`
- **Checklist:** [`governance/phase_00_checklist.yaml`](../../governance/phase_00_checklist.yaml)

> **Before:** an architecture on paper. **After:** that architecture is executable. Every boundary rule in DEPENDENCY_RULES is a CI check, each check is proven to fire on a deliberate violation, and the invariant register is enforced by a script.

## Phase gate (IMPLEMENTATION_ROADMAP, Phase 00)

- [x] **Scaffold.** npm workspaces (`protocol`, `core`, `adapters`, `runtime`), strict NodeNext TypeScript, exports maps, `engines.node ">=24 <27"`, `private`, `UNLICENSED`, and `.npmrc` with `save-exact` and `engine-strict`. Evidence: `tests/fitness/manifests.spec.ts`, `tests/fitness/exports.spec.ts`.
- [x] **Domain primitives, types only.** Shared kernel (branded IDs, `CanonicalPath`, `SourceRange`, `ContentHash`, `Result`, `DomainError`, `Clock`, `Hasher`, `CancellationSignal`), with validating constructors only where the kernel owns the format. Evidence: `packages/core/test/shared-kernel.spec.ts`, `tests/fitness/type-level.spec.ts` (including the check that a real `AbortSignal` satisfies `CancellationSignal`, C-01).
- [x] **Phase 01 port interfaces.** `FileSystem`, `ConfigSource`, `WorkspaceRepository`, `RevisionStore`, `RevisionWriter`, `LeaseManager`, `JobRepository`, `ChangeSource`. These are type declarations only, and Phase 01 may refine them.
- [x] **dependency-cruiser.** 16 rules, each proven to fire on its fixture in `tests/fitness/fixtures/violations/`. The real tree has 0 violations and 0 unresolved imports. Evidence: `tests/fitness/depcruise-rules.spec.ts`.
- [x] **ESLint 9 guards** (FF-DEP-002/003/004/005, FF-CPX-001 warn, FF-CPX-005), proven to fire. Evidence: `tests/fitness/eslint-guards.spec.ts`.
- [x] **Governance.** Files moved to `/governance`, plus `fitness.yaml`, `shared-kernel.allowlist` and `phase.yaml`. `scripts/check-governance.mjs` runs 10 checks. Its failure modes are tested: invalid schema, unparseable YAML, a due CRITICAL invariant without a test, a removed ID, a strict or lenient missing base, md↔yaml parity, a missing depcruise rule, a non-allow-listed kernel file, a `utils/` folder, a CodeForge manifest dependency, and pending items of an earlier phase. Evidence: `tests/fitness/governance.spec.ts`.
- [x] **Exact pins** recorded in the checklist (`pinned_versions`).
- [ ] **CI green on windows-latest and ubuntu-latest × Node 24 and 26.** The workflow is written (`.github/workflows/ci.yml`), but it has only been verified locally, on **Windows + Node 24.15.0**. Linux and Node 26 have not been run.

Local result (`npm run verify`, Windows, Node 24.15.0): typecheck OK, lint 0 problems, depcruise 0 violations, **8 test files / 93 tests passed**, governance OK.

## Decisions made in this phase

| Decision | Reason | Recorded in |
|---|---|---|
| TypeScript **6.0.3**, not 7.0.2 | `typescript-eslint` 8.72.1 supports only `typescript <6.1.0` | ADR-0005, E-32; R-03 and ADR-0016 updated |
| Stay on ESLint 9 (OQ-08) | No forcing reason, since `typescript-eslint` supports 9 and 10 | ADR-0005, RISKS |
| Do not adopt ArchUnitTS (OQ-10) | `depcruise --metrics` already gives Ca/Ce/instability; avoids a single-maintainer dependency | ARCHITECTURE_FITNESS §1, fitness.yaml FF-CPX-002 |
| FF-DEP-002 has no type-only exception | Third-party types must not cross the ACL into core | ARCHITECTURE_FITNESS §4 note |
| Package unit tests in `packages/<pkg>/test/` | Keeps `vitest` imports outside `src/` purity rules and build output | TEST_STRATEGY §2 |
| Current phase recorded in `governance/phase.yaml` | Gives check-governance one source of truth for `phase <= current` | `scripts/check-governance.mjs` |

## Findings during implementation

- **dependency-cruiser ignores package `exports` maps** unless `exportsFields: ['exports']` is set explicitly. Our packages have no `main`, so workspace imports showed up as unresolved, and the unresolved-import assertion caught it.
- **`exclude: dist/`** made dist-resolved modules look unresolved. Replaced with `doNotFollow`. As a consequence, `npm run build` must precede `npm run depcruise`, and CI does that.
- The FF-BND-001 `$1` back-reference assumption was confirmed: it works in dependency-cruiser 18.7.0.

## Scope review (NFR-044)

No adapter implementation, no SQLite, no tree-sitter, no file walking, no CLI, no JSON-RPC and no extension package were added. The non-documentation code consists of the build and test scaffold, type declarations, three tiny validating constructors in the shared kernel, the governance script and the tests.

## Honest self-review

- The port signatures are the most speculative part of this phase. They follow DOMAIN_MODEL and ADR-0015, but no implementation has used them yet. Phase 01 is expected to refine them and must record the changes.
- `WorkspaceSettings` and `UserSettings` only sketch the SEC-005 split. The real allow-list schema belongs to Phase 01.
- On pushes to `main`, the no-removal check compares `main` with itself. The effective gate is the pull-request run, which compares with the base branch.
- `npm audit` reports 11 moderate findings, all through `minimatch` in the dev-only ESLint toolchain. They are not shipped and are tracked as a known issue.

## Deferred (explicitly out of scope)

`fast-check` (installed when Phase 01 adds property tests), FF-BND-003/004/006/008, all FF-DAT except 007, all FF-PRF, the benchmark harness, and spikes S1 and S2 (Phase 01 and Phase 02 entry).

## Next step

Push `phase-00`, open a PR to `main`, and confirm the CI matrix. When it is green, set P00-13 to `done`, mark this document **Accepted**, and bump `governance/phase.yaml` to `current_phase: 1` as the first commit of Phase 01. check-governance then requires the Phase 01 invariant tests and a `phase_01_checklist.yaml`.
