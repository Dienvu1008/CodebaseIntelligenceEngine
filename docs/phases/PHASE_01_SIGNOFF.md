# Phase 01 Sign-off: Workspace and File Intelligence

- **Status:** **Proposed.** Awaiting CI on the closing commit and the owner's approval before `main` is fast-forwarded (branch workflow, IMPLEMENTATION_ROADMAP).
- **Date:** 2026-10-31
- **Branch:** `phase-01` (from `main` at `13a0e74`)
- **Checklist:** [`governance/phase_01_checklist.yaml`](../../governance/phase_01_checklist.yaml), all 15 items done.

> **Before:** an executable architecture with no behavior.
> **After:** `cie dev index` turns a real workspace into an immutable, atomically published, crash-safe revision of its files and structure, identical byte for byte on Windows and Linux.

## Phase gate

- [x] **Every Phase 01 invariant has a passing test, on all four CI cells** (windows/ubuntu × Node 24/26). WS-001..004, SN-001..005, SN-007, SEC-002, SEC-005 and AI-004 have tests under `tests/invariants/`. With `CIE_PHASE=2`, check-governance reports no `invariant-test-presence` errors.
- [x] **Fitness functions active:** FF-DEP-001..008 (incl. the per-adapter allow-list 008b–e), FF-BND-001/002/003/005/007, FF-CPX-001 (warn)/004/005, FF-DAT-001/002/004/005/007, FF-PRF-006 (correctness). Every depcruise and ESLint rule is proven to fire on a deliberate violation.
- [x] **Acceptance criteria (roadmap):**
  - `cie dev index` publishes revision 1 on `fixtures/*`, Zod, Requests and CodeForge-v2, using a `--state-dir` outside the fixture.
  - The export is byte-identical across runs and across OSes: `tests/cross-platform/export-golden.spec.ts`, required CI, also verified from a fresh clone with `core.autocrlf=true`.
  - A kill at any stage, followed by a restart, yields a valid revision. A real SIGKILL is injected at all 7 stages (`sn-005.spec.ts`).
  - A concurrent second writer gets `CIE_BUSY` (`sn-004.spec.ts`).
  - A corrupt `index.db` is quarantined and rebuilt (`index-db-lifecycle.spec.ts`, B-11).
- [x] **Benchmarks recorded without thresholds:** B-01, B-02, B-10 and B-11 for Zod, Requests and CodeForge-v2 (reference), plus the CodeForge-v2 working tree (dogfood). See `benchmarks/results/2026-10-31-fe26ce0c-*`.
- [ ] **CI green on the closing commit** (the one that bumps `governance/phase.yaml` to 2), and **owner approval**.

## Commits

| Commit | Content |
|---|---|
| `4c9ccc7`, `867398a` | Spike S1 (better-sqlite3: WAL, FK, FTS5, WAL isolation, CAS) and its closure; PathCanonicalizer; ManifestBuilder |
| `b4dbd34` | IgnoreEvaluator: gitignore semantics in the core, git oracle |
| `74bfa30` | GuardedFileSystem, WriteConfinement |
| `b3fe363` | Branch workflow recorded |
| `ff4a8cd` | Synchronization domain; SQLite index store (validity intervals, CAS publish, lease) |
| `ff0cdc8` | Config allow-lists, structural nodes, enumerator, IndexService, dev CLI, crash injection |
| `b6c5365` | state.db migrations, job history, data-integrity fitness |
| `d630365`, `fe26ce0`, `2e1998d` | Benchmark harness, export spec plus cross-OS golden, first baselines |
| *closing commit* | fixtures workflow fix, this sign-off, Phase 02 checklist, `phase.yaml` → 2 |

## Components delivered

- **Core (pure; no Node or npm imports):**
  - Shared kernel: unchanged allow-list; `Hasher.sha256Text` added.
  - Workspace: `canonicalizePath`, `IgnoreEvaluator`, `buildManifest`, `deriveStructure`, settings allow-lists, `enumerateWorkspace`, `decodeUtf8`.
  - Synchronization: revision and job state machines, `decidePublish`, `evaluateFreshness`, `planRecovery`, `runFullIndex`.
- **Adapters:**
  - `fs`: GuardedFileSystem, WriteConfinement, JsonWorkspaceRepository, NodeHasher, SystemClock.
  - `config`: FileConfigSource.
  - `sqlite`: index store (schema v2), lease, structure store, state store, migrations.
- **Runtime:** composition root; `cie dev index|status|export`; `--timings`; dead local lease holders released.
- **Tooling:** `scripts/bench/*`, `benchmarks/fixtures.json`, results schema, `.github/workflows/fixtures.yml` (not required).
- **Specs:** `docs/specs/EXPORT_FORMAT.md`.

## Decisions taken in this phase

| Decision | Reason | Where |
|---|---|---|
| gitignore semantics implemented in the core, not through a library | The core has zero dependencies; equality with real git is proven by an oracle | Owner-approved; `ignore-evaluator.ts` |
| Case-sensitive ignore matching on every OS; git's `info/exclude` and `core.excludesFile` are not read | Identical manifests on every machine (WS-004) | `ignore-evaluator.ts` header |
| Non-portable names (`aux.c`, `a:b`, trailing dot or space) are never indexed; they are reported as *unrepresentable* | Determinism across OSes | `path-canonicalizer.ts`, `enumerate.ts` |
| `\` is a path separator on every OS | Same | `path-canonicalizer.ts` |
| Symlinks are never followed (`symlink` or `symlink_escape`, size 0) | No cycles; no target paths leaking into exports | `enumerate.ts` |
| Recovery abandons unfinished revisions; resuming is deferred to Phase 05 | A full re-index is cheaper than correct checkpointing (SN-005 allows either) | `recovery.ts` |
| Structural node ids are location-based (`pkg:npm:<dir>`) | Same-named packages in a monorepo never collide (deviation from KNOWLEDGE_GRAPH_DESIGN §2) | `structure.ts` |
| Port refinements: `FileSystem.readFile/list`, `FileManifestReader` and `RevisionWriter.publish` return `Result`; `stageManifest`, `stageStructure`, `validate`; `LeaseManager.heldByOther` | Explicit outcomes instead of exceptions (allowed by the Phase 00 sign-off) | ports files |
| The `cie.config.json` allow-list rejects sensitive and unknown keys; unreadable or malformed config fails closed | SEC-005; a typo must not silently drop exclusions | `settings.ts`, `file-config-source.ts` |
| A `--state-dir` equal to, above or inside the workspace (other than `.cie`) is refused | Otherwise source files would become writable (SEC-002) | `write-confinement.ts` |
| Gate semantics: `current_phase` is the phase in progress (C-11) | Otherwise a phase would be red from its first commit | `check-governance.mjs`, ADR-0012 |

## Problems found by our own checks (and fixed)

- **Mutation testing exposed two test gaps.**
  - The git oracle did not exercise the parent-exclusion rule. A per-file point query was added.
  - Store tests did not detect an abandon that failed to re-open closed rows. Those rows would silently vanish from later revisions; the tests now compare the content of the next revision.
  - Both SN-002 defenses (the domain base check and the SQL CAS) are each independently sufficient.
- **Windows-only bug:** a corrupt `state.db` was renamed while still open. Linux CI could never have caught it.
- **FF-BND-003** caught a duplicate of the visibility predicate inside an SQL comment.
- **FF-DEP-007** caught a test in `packages/` spawning git. The test moved to `tests/oracles/`; the rule was not loosened.
- **dependency-cruiser** ignores package `exports` maps unless `exportsFields` is set.
- **The first dogfood run** caught a live CodeForge-v2 tree being edited during measurement. Results now carry `stableDuringRun`; a changing reference clone aborts the run.
- **The fixtures workflow** used `runner.temp` in job-level `env`, which GitHub rejects. It was rejected on push even though the workflow is not part of the gate, and is now fixed.

## Benchmarks (first baselines, reference machine, B-02 median)

| Fixture | Indexed files | Wall time | Peak RSS |
|---|---|---|---|
| Zod v4.6.7 | 693 | 887 ms | 62 MB |
| Requests v2.34.2 | 123 | 289 ms | 55 MB |
| CodeForge-v2 `d885bed0` (reference) | 656 | 816 ms | 54 MB |

All runs are deterministic. All three fixtures are now *measured* small tier. Enumeration dominates the time.

**Noise:** wall-time CV reaches 0.37 for B-01 and B-10 on this machine. Per BENCHMARK_STRATEGY §6 step 2, the noise floor must be addressed (dedicated runner or controlled conditions, OQ-13) before any target is proposed.

## Honest self-review

- **The SN-001 watermark check is structurally present but trivially satisfied.** Without a change log (Phase 05), a full index uses the head watermark on both sides. Freshness reports `current` once anything is published, so it cannot yet see unindexed edits.
- **Every run creates a new revision**, even when nothing changed (unchanged rows are not rewritten). A no-op short-circuit belongs to Phase 05 incremental work (FF-PRF-001).
- **Enumeration** reads every file serially, which is its whole cost. It is unoptimized by design until Phase 05 measures alternatives.
- **The `languageForPath` extension map is provisional.** Phase 02's LanguageRegistry becomes the authority, with a golden test asserting agreement.
- **GuardedFileSystem** has a realpath-then-read TOCTOU window. A concurrent local attacker is outside the threat model; this is documented in the adapter.
- **`maxRssKb`** comes from `process.resourceUsage()`. It is comparable on one machine and OS, not across OSes.
- **FF-DAT-005** tests the migration chain programmatically. Committed released-schema fixtures (`state-vN.db`) begin with the first public release.
- **`state.db` salvage** after corruption is deferred. It holds only job history today, so quarantine plus a fresh start loses nothing that matters.
- **CI green status was reported by the owner,** because the agent has no Actions access. Ubuntu cells ran 275 tests, including the Linux-only non-portable-name case; Windows cells ran 274 plus 1 skip.

## Deferred (explicitly out of scope)

- Symbol extraction (Phase 02).
- Change log, watcher, incremental indexing, resume-from-checkpoint and the no-op revision short-circuit (Phase 05).
- Medium and large benchmark tiers, and performance targets (DEF).
- Released-schema migration fixtures (first release).
- `state.db` salvage (Phase 04).
- `npm audit`: 11 moderate, 0 high, 0 critical. All of them come through `minimatch` in the ESLint and typescript-eslint dev chain, the same set as at Phase 00. Dev-only; nothing is shipped.

## Test progression

| Point | Tests |
|---|---|
| Phase 00 exit | 93 |
| Phase 01 exit | 274 on Windows plus 1 skipped; 275 on Linux. 31 spec files: invariants, fitness, oracle, integration, cross-platform, adapters, core. |
