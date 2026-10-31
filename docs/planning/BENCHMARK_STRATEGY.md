# Benchmark Strategy

> Status: Baseline v0.1 · Related: NFR-060..066, FF-PRF-*, DEC-10
> **Rule (NFR-066):** this document defines **methodology first**. It contains **no numeric performance thresholds**. Targets are proposed only after baselines and their variance have been measured (§6).

## 1. Goals

1. Detect correctness regressions in extraction, the graph and documentation on real code.
2. Measure performance: indexing cost, incremental cost, memory, query latency and recovery.
3. Measure intelligence quality: the precision and recall of structural facts, the quality of inferred claims, and anchor and link robustness.
4. Produce comparable, reproducible results over time.

## 2. Methodology

### 2.1 Environment capture
Every run records the following in its result JSON:

| Category | Fields |
|---|---|
| Machine | OS and version, CPU model and core count, RAM, disk type (SSD/HDD/network), filesystem |
| Software | Node version, CIE commit, dependency lockfile hash, grammar manifest hash, TypeScript version |
| Configuration | Fixture commit SHA, CIE config hash, LLM model and digest (when relevant) |
| Load | System load before the run; antivirus and indexer status on Windows, where the user can determine it |

### 2.2 Procedure
- **Cold vs. warm.**
  - *Cold*: no `.cie/`, fresh process, OS file cache not controlled. It is reported as-is and labeled as such.
  - *Warm*: second run in the same session.
  - Both are reported, and they are never mixed in one statistic.
- **Warmup:** one discarded run per scenario for warm measurements.
- **Repetitions:** at least 5 measured runs per scenario. Report median, p95 (for latency distributions), min and max, plus the coefficient of variation (CV).
- **Isolation:** the benchmark runner is the only CIE process. LLM-free (`llm-none`) unless the scenario is LLM-specific.
- **Reference machine:** one designated developer machine plus CI runners. CI numbers are **trend-only** because shared runners are noisy. Gating uses the reference machine or a dedicated runner (OQ-13).

### 2.3 Measurements

| Metric | Method |
|---|---|
| Wall time | High-resolution timer around job phases (enumerate, extract, resolve, validate, publish) |
| Peak memory | Sampled `process.memoryUsage().rss` (100 ms) plus `resourceUsage().maxRSS` |
| DB size | `index.db` and `state.db` bytes after `VACUUM`-free publish, plus the WAL size |
| Work counters | Files parsed, symbols and edges written, rows closed. These are exact counts used for FF-PRF-001. |
| Query latency | Client-side round trip over stdio, per method, using a fixed query set per fixture (§4) |

## 3. Tiers and fixtures

Tier boundaries are **classification rules, not targets**. They are based on the indexed source file count after ignore rules, measured in Phase 01.

| Tier | Boundary (indexed files) | Candidate fixtures | Language | Role |
|---|---|---|---|---|
| **Small** | < 2,000 | **Zod** (TS library) | TS | **MVP gate** |
| | | **Requests** | Python | **MVP gate** (Python adapter) |
| | | **CodeForge-v2** (local, read-only copy) | TS | **MVP gate: dogfood fixture only.** It is not an architectural target. [Assumption] small tier, to be confirmed by count. |
| **Medium** | 2,000 – 20,000 | **Django** | Python | Post-MVP gate ([DEF]) |
| **Large / scaling** | > 20,000 or synthetic | **TypeScript** compiler repo (includes a very large `tests/cases` tree; [Assumption] large tier) | TS | Post-MVP ([DEF]) |
| | | **Synthetic generator** (`benchmarks/synthetic`: N modules, a controllable import fan-out, class hierarchies, Python/TS mix; N ∈ {1k, 5k, 10k, 25k, 50k, 100k}) | TS + Py | Scaling curves (FF-PRF-005) |

- Fixtures are pinned to a commit SHA recorded in `benchmarks/fixtures.json`, selected in Phase 01. Clones are cached outside the workspace and **never modified**. CIE writes its `.cie/` to a per-run output directory ([Proposal] a `--state-dir` override), so fixture repositories stay pristine. This applies to CodeForge-v2 as well.
- If a fixture lands in a different tier than assumed, the tier assignment follows the measured count.

## 4. Scenarios

| ID | Scenario | Tiers |
|---|---|---|
| B-01 | Full index, cold | all |
| B-02 | Full index, warm (`.cie` deleted, OS cache warm) | all |
| B-03 | No-op incremental (no changes) | all |
| B-04 | Single-file body edit → publish | all |
| B-05 | Single-file signature or export change (wide fan-in) → publish | all |
| B-06 | Rename a widely referenced symbol | small, medium |
| B-07 | Move a file | small, medium |
| B-08 | Branch switch simulation (apply a diff touching ≈5% of files) | medium, large |
| B-09 | Query suite per method (fixed query list per fixture: 20 symbol searches, 20 references, 10 dependency closures at depth 3, 10 impact queries, 5 flows) | all |
| B-10 | Crash during extraction / resolve / publish → restart → recovered and published | small (correctness), all (time) |
| B-11 | Corrupted `index.db` → detected → rebuilt | small |
| B-12 | Extension activation and first wiki panel render (Phase 06) | small |
| B-13 | LLM summary generation for 20 concepts (Phase 07, local model) | small |

## 5. Metrics

### 5.1 Functional correctness (blocking where marked)

| Metric | Definition | Gate |
|---|---|---|
| Golden equality | Extraction and graph export equal the reviewed snapshot (fixtures in `fixtures/`) | Blocking (FF-DAT-006) |
| Invariant validator | RevisionValidator violations = 0 on every benchmark fixture revision | Blocking |
| Determinism | Two full indexes give an identical export hash (and identical across OSes) | Blocking |
| Recovery correctness | B-10/B-11 end with a valid published revision whose export equals a clean index | Blocking |

### 5.2 Performance (FF-PRF-*)

| Metric | Scenario | Gate |
|---|---|---|
| Full index time (median), throughput (files/s) | B-01, B-02 | Regression vs baseline (§6) |
| Incremental time and **work counters** | B-03..B-08 | Counters: structural assertion (no-op = 0 files parsed; single-file edit = 1 file + its declared dependents) — blocking from Phase 05. Time: regression vs baseline. |
| Peak RSS, DB size | B-01 | Regression vs baseline |
| Query latency p50/p95/p99 per method | B-09 | Regression vs baseline |
| Recovery time | B-10, B-11 | Regression vs baseline |
| Activation time, Webview bundle size | B-12 | Regression vs baseline |
| Scaling slope (time and memory vs N) | synthetic | Trend report ([DEF] gate) |

### 5.3 Intelligence quality

| Metric | Definition | Ground truth |
|---|---|---|
| Symbol precision / recall (per language, per kind) | Matched by (path, qualifiedName, kind, range overlap) | TS: TS compiler declarations for fixtures. Python: hand-verified sets for `fixtures/py-*` and a sampled subset of Requests. |
| Reference and call precision / recall (per language, per precision class) | Edge matching by (from, to, site) | TS: `scip-typescript` output (E-16) as an independent oracle. Python: `scip-python` output (E-17) generated offline once per fixture SHA. |
| Import resolution rate | Resolved / total imports; `unresolved` share split by reason | Manual audit sample |
| Anchor robustness | Fraction of anchors resolving correctly after the `drift-scripts` sequences (scenarios A–G) | Scripted expectations |
| Link state accuracy | Fraction of links whose state (resolved/redirected/stale/broken) matches the expectation after drift | Scripted |
| Staleness detection recall | Fraction of generated sections correctly marked stale after source mutations (mutation testing) | Scripted mutations |
| Inferred claim acceptance (Phase 07) | Fraction of LLM-inferred claims judged correct by a reviewer on a fixed sample (≥ 50 per model); also the rate of `insufficient_evidence` answers | Human review protocol (two reviewers, disagreements logged) |
| Citation validity (Phase 07) | Fraction of generated sentences whose cited IDs exist and support them | Automatic existence check plus a human-sampled support check |

The Python vs. TS quality gap is reported explicitly. It is expected and is documented in the capability matrix.

## 6. Target-setting procedure

1. **Baseline.** On the reference machine, run each scenario at least 5 times per fixture, and record the median and CV.
2. **Noise floor.** If CV exceeds an agreed limit, fix the environment before setting targets. That limit is chosen after the first baseline from observed variance and is recorded in the ADR.
3. **Regression budget.** Proposed rule: a regression is a median slower than the baseline by more than `max(k · σ, tolerance)`, where `k` and `tolerance` are fixed after observing variance (at the first post-baseline review).
4. **Absolute product targets** (e.g. "interactive" query latency, acceptable incremental latency after save) are **[Open] OQ-14**. They are proposed to the stakeholder after the Phase 05 baselines and recorded in an ADR before becoming gates.
5. **Ratchet.** Baselines are updated only by an explicit PR with justification. Improvements may tighten them automatically.

## 7. Phasing

| Phase | Benchmark work | Gating |
|---|---|---|
| 01 | Harness, environment capture, fixture pinning, B-01/B-02/B-10/B-11 on small | Correctness only |
| 02–03 | Quality metrics for symbols and references (TS oracle via scip-typescript run offline) | Golden + determinism |
| 05 | B-03..B-08, first baselines on small and CodeForge-v2 | Work counters blocking. Time and memory advisory until baselines are agreed. |
| 06 (MVP) | B-09, B-12 | **MVP gate = small tier + CodeForge-v2 only** (NFR-064): correctness blocking, work counters blocking, performance regressions vs. the agreed baseline |
| 07 | B-13, claim-quality protocol | Report |
| post-MVP | Medium (Django) and large (TypeScript, synthetic) tiers | [DEF] Phased in once baselines exist |

## 8. Result format

`benchmarks/results/<date>-<commit>-<machine>.json` holds the environment, scenario, raw samples and summary statistics. A JSON Schema is committed in Phase 01, and a small script renders trend tables. Results are not committed from CI runners; they are published as artifacts.
