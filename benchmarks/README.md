# Benchmarks

Methodology: [BENCHMARK_STRATEGY.md](../docs/planning/BENCHMARK_STRATEGY.md). This directory holds the fixture pins (`fixtures.json`), the result schema (`results.schema.json`) and committed results (`results/`).

**No performance thresholds exist** (NFR-066). Results are measurements only. Targets are proposed once baselines and their variance have been reviewed (BENCHMARK_STRATEGY §6).

## Two kinds of runs

| Mode | Source | `reproducible` | Use |
|---|---|---|---|
| `reference` | A clone in the disposable cache at the **pinned commit** (`core.autocrlf=false`, clean tree, verified before every run) | `true` | Baselines and comparisons |
| `dogfood` | A **live working tree**, read in place; CIE state goes to a separate state dir | `false` | Realism checks; never a baseline |

Every result records:
- the fixture's pinned commit, its actual commit and whether the tree was dirty;
- CIE's own commit and dirty flag;
- the lockfile hash;
- the OS, CPU and memory, a hash of the machine name, and the system load.

Results produced from a dirty CIE tree must not be used as baselines.

## Commands

```sh
npm run build
node scripts/bench/fixtures.mjs fetch          # clone or verify the pinned reference fixtures (cache: fixtures.mjs where)
node scripts/bench/run.mjs --fixture zod       # B-01, B-02, B-10, B-11 x 5 repetitions -> benchmarks/results/
node scripts/bench/run.mjs --fixture codeforge-v2-worktree --note "dogfood"   # live tree, labeled non-reproducible
node scripts/bench/fixtures.mjs clean          # the cache is disposable; fetch rebuilds it
```

Override the cache location with `CIE_BENCH_CACHE`.

## Scenarios (Phase 01)

| ID | Measures |
|---|---|
| B-01 | Full index on a cold start: new process, empty state dir. The OS page cache is **not** controlled, and results are labeled accordingly. |
| B-02 | Warm full index: one discarded warm-up run, then the measured runs, each with an emptied state dir. |
| B-10 | Recovery: SIGKILL at `staged`; the measured run recovers and must publish a tree identical to the pre-crash content. |
| B-11 | A corrupt `index.db` (overwritten with garbage); the measured run quarantines it and rebuilds. |

Each sample records:
- wall time (process spawn to exit) and in-process time;
- time to each pipeline stage;
- peak RSS;
- work counters (rows inserted, closed and unchanged);
- store sizes;
- the manifest hash. The summary reports `deterministic: true` only if every sample produced the same hash.

## Where benchmarks run

- **Required CI never clones external fixtures and never measures performance.** It runs the deterministic cross-OS golden check on CIE's own `fixtures/xplat-basic` (`tests/cross-platform/export-golden.spec.ts`).
- `.github/workflows/fixtures.yml` (weekly or manual, not required) exports Zod and Requests on Windows and Linux and byte-compares the results.
- Performance numbers come from the reference machine only.
