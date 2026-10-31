# ADR-0010: Tree-sitter via WASM; Version and ABI Strategy

- **Status:** Accepted. Revised in Phase 02: OQ-09 resolved (vendored artifacts); spike S2 passed on the full CI matrix.
- **Date:** 2026-10-31
- **Related:** [CODE_INTELLIGENCE_STRATEGY](../CODE_INTELLIGENCE_STRATEGY.md), ADR-0006, A-01, OQ-09

## Context

- [Fact] CodeForge pins `web-tree-sitter@0.20.8` together with `tree-sitter-wasms@0.1.13`. Newer runtimes reject those grammars (E-26), so the ABI coupling is real.
- [Fact] `web-tree-sitter` is at 0.27.1 (E-02). Official grammar packages now ship their own `.wasm` files: `tree-sitter-typescript` 0.23.2 (E-03), `tree-sitter-python` 0.25.0 (E-04) and `tree-sitter-javascript` 0.25.0 (E-34, which resolves E-05).
- [Fact] The grammar packages also ship native prebuilds for the Node `tree-sitter` binding, and each declares `install: node-gyp-build` plus a `node-addon-api` dependency for it (E-03, E-04, E-34). CIE uses none of that.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **A. web-tree-sitter (WASM) + official grammar `.wasm` files** | No native compilation; identical behavior on all OSes; usable in-process later (ADR-0002) | WASM is slower than native [Assumption, measured in benchmarks]; ABI matching between runtime and grammar |
| B. Native `tree-sitter` Node binding + grammar prebuilds | Faster | A second native-module family with its own ABI; Electron-incompatible for future in-process use |
| C. Vendored grammars built by CIE with a pinned tree-sitter CLI | Full control of ABI | Build tooling (emscripten/docker) in CI; maintenance |

## Decision

**Option A**, with **Option C as the fallback** if a future grammar or runtime upgrade breaks ABI compatibility.

1. Pin the exact version of `web-tree-sitter` (a dependency of `@cie/adapters`) and of each grammar package (in `scripts/grammars/fetch.mjs`). Record the grammar ABI version alongside the parser version in `ExtractionProducer.version` (SY-005).
2. **Vendor the grammar artifacts (OQ-09, resolved).** `packages/adapters/grammars/` holds the four `.wasm` files, each package's LICENSE, a generated `ATTRIBUTION.md` and `grammars.lock.json`. All of it is produced by `scripts/grammars/fetch.mjs` and never edited by hand. The directory ships in the package (`"files"`). The grammar npm packages are **not** dependencies of any CIE package.
3. **The lock records provenance.** For each grammar: language, ABI version; source package, version, registry tarball URL and sha512 integrity; artifact file name, SHA-256 and byte size; license SPDX id, license file name and its SHA-256. It also records the `web-tree-sitter` version the artifacts were verified against. The output has no timestamps, so `fetch.mjs --check` can re-fetch and prove the committed directory is byte-for-byte reproducible.
4. **Integrity is verified at first load, once per process.** `GrammarLoader` (`packages/adapters/src/treesitter/grammar-loader.ts`) reads the artifact, compares size and SHA-256 with the lock (`GRAMMAR_INTEGRITY_MISMATCH` otherwise), passes the *same verified bytes* to `Language.load` (no second read, so no window between check and use), then checks the loaded ABI against the lock (`GRAMMAR_ABI_MISMATCH`). The verified `Language` is cached; `defaultGrammarLoader()` is the process-wide instance. The parsing hot path never hashes an artifact again. Failures are not cached, so a later call retries. Lock entries may only name bare files in the grammar directory.
5. Keep extraction queries (`tags.scm`-style) as CIE-owned files with golden tests, because the upstream `queries/tags.scm` may change between versions.
6. Upgrades follow the procedure below **and** need green golden tests (FF-DAT-006).

### Why vendoring (OQ-09 option A) and not the alternatives

| | A. Vendor the minimal `.wasm` artifacts (chosen) | B. Install the grammar packages | C. Download the artifacts on every clean build |
|---|---|---|---|
| What lands in the repo/install | ~3.7 MB of `.wasm` + licenses + lock | Full packages: native sources, prebuilds for every platform, bindings, `node-addon-api` | Nothing committed |
| Install scripts | None | `node-gyp-build` runs on install unless every consumer passes `--ignore-scripts`, which is global: npm has no per-package switch | None |
| Native code | None | Unused native bindings ship to every user; prebuild gaps fail installs on uncommon platforms | None |
| Dependency graph | Unchanged | Adds grammar packages and their transitive deps; `tree-sitter-typescript` pulls a second `tree-sitter-javascript` (0.23) that conflicts with the pinned 0.25 | Unchanged |
| Network at build time | No | Yes (normal `npm ci`) | Yes, on every clean build and CI run; registry outage or rate limiting breaks builds |
| Reproducibility | Bytes are in git; the lock proves origin; `--check` proves the fetch is reproducible | Depends on lockfile integrity; artifacts are not reviewed in diffs | Depends on the registry still serving identical bytes |
| Review of upgrades | A grammar change is a visible binary + lock diff in a PR | Hidden in `package-lock.json` | Hidden in a script constant |
| Cost | Repository size grows by each upgrade's binary diff | Install weight and script risk for every user | Build fragility; offline builds impossible |

Option A keeps the supply chain to one narrow, auditable step that a maintainer runs deliberately. The repository-size cost is small and bounded by how often grammars change. B was rejected for its install scripts, unused native code and the duplicate `tree-sitter-javascript`. C was rejected because required CI must not depend on external downloads (the same policy as P01-13 fixtures), and it gives no review point.

### Upgrade procedure

Run each step in order; stop at the first failure.

1. **Fetch.** Edit the pin in `GRAMMARS` (`scripts/grammars/fetch.mjs`), or the `web-tree-sitter` pin in `packages/adapters/package.json`. Then run `node scripts/grammars/fetch.mjs --out packages/adapters/grammars`. It calls `npm pack --ignore-scripts`, so no package code runs.
2. **Verify source integrity.** The script reads `dist.integrity` and `dist.tarball` from the registry with `npm view`. It rejects a tarball whose sha512 differs, or whose `package.json` names another package or version.
3. **Extract.** The verified tarball is unpacked in a temporary directory, and only the `.wasm` and the LICENSE are copied out; the temporary directory is then deleted.
4. **Compute SHA-256.** The script records the artifact SHA-256 and byte size, and the ABI version as loaded by the pinned `web-tree-sitter`.
5. **Update lock metadata.** `grammars.lock.json` and `ATTRIBUTION.md` are regenerated. Run `node scripts/grammars/fetch.mjs --check packages/adapters/grammars` to confirm a fresh fetch reproduces every byte.
6. **Run the compatibility spike and tests.** `npm run verify`, including `packages/adapters/test/treesitter/spike-s2.spec.ts` (load, ABI, parse, query, integrity) and the extraction golden tests. Then confirm the full CI matrix is green. An ABI change in the lock diff needs an explicit note in the PR. A golden diff needs a review, as for any FF-DAT-006 change.
7. **Review license and attribution changes.** Read the diff of every `*.LICENSE`, of the `license` fields in the lock and of `ATTRIBUTION.md`. A change of SPDX id or of copyright holders needs owner approval before merge, because ADR-0013 (license) is still open.

### Spike S2 results (Phase 02 entry)

- **Local (win32-x64, Node 24.15.0, web-tree-sitter 0.27.1):** passed (E-34).
  - `tree-sitter-typescript.wasm` and `tree-sitter-tsx.wasm` (0.23.2) have ABI 14.
  - `tree-sitter-javascript.wasm` and `tree-sitter-python.wasm` (0.25.0) have ABI 15.
  - All four parse their samples without error nodes and answer capture queries.
  - `--check` reproduced the vendored directory byte-for-byte.
- **JS grammar strategy (E-05):** `tree-sitter-javascript` 0.25.0 ships its own `.wasm`, so JS uses the official JavaScript grammar. There is no need to parse JS with the TS grammar.
- **Full CI matrix (windows/ubuntu × Node 24/26):** passed for commit `5beff06` (E-34). A-01 is closed.

## Consequences

- Grammar churn becomes visible through golden fixtures and binary diffs instead of silent behavior changes.
- The repository carries ~3.7 MB of binary artifacts, plus the diff of each future upgrade.
- Grammar provenance and licenses are reviewable in the repository, without network access.
- Option C remains available, at an added CI cost.

## Evidence

E-02..E-06, E-26, E-34.
