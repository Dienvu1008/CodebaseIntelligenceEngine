# Requirements

> Status: Baseline v0.1 · Tags: **[HR]** hard requirement, **[PREF]** preference, **[BT]** benchmark target, **[DEF]** deferred decision (see [README §3](README.md#3-requirement-classification-tags)).

## 1. Decision register (stakeholder decisions)

Each decision below came from the planning dialogue and is traceable to requirements and ADRs.

| ID | Decision | Class | Requirements | ADR |
|---|---|---|---|---|
| DEC-01 | All planning docs are in English | HR | NFR-001 | — |
| DEC-02 | Transport-agnostic core. A separate local process is the primary MVP deployment. In-process deployment is a future option. | HR / DEF | NFR-010..013 | [0002](ADR/0002-transport-agnostic-core-out-of-process-mvp.md) |
| DEC-03 | TS/JS deep support. Python through the LanguageAdapter abstraction. Dart is a planned future language, not MVP. | HR / DEF | FR-020..027 | [0006](ADR/0006-language-support-priorities.md) |
| DEC-04 | Split storage: human or curated wiki pages in the repo; SQLite index, generated drafts and caches in `.cie/`; publishing generated pages to the repo is opt-in config | HR | FR-040..046 | [0007](ADR/0007-split-documentation-storage.md) |
| DEC-05 | Local-first LLM. CIE's own provider port, Ollama default, cloud opt-in per workspace with secret redaction. Everything works without an LLM. | HR | FR-060..066 | [0009](ADR/0009-local-first-llm-policy.md) |
| DEC-06 | JSON-RPC 2.0 over stdio for the MVP. MCP as a first-class adapter from Phase 09. HTTP deferred. | HR / DEF | FR-070..078 | [0003](ADR/0003-transport-jsonrpc-stdio-then-mcp.md) |
| DEC-07 | Machine-readable governance from day one | HR | NFR-040..043 | [0012](ADR/0012-machine-readable-governance.md) |
| DEC-08 | Research scope: core set plus SCIP/LSIF | — | — | [0011](ADR/0011-scip-optional-enricher.md) |
| DEC-09 | Tooling: npm workspaces, TS strict ESM, Vitest, ESLint 9, dependency-cruiser, React + TS Webview, Vite (Webview), esbuild (extension host). Node version chosen by verification. | PREF / HR | NFR-050..055 | [0004](ADR/0004-node-lts-selection.md), [0005](ADR/0005-tooling-stack.md) |
| DEC-10 | Benchmarks: three tiers; Zod, TypeScript, Requests, Django, synthetic repos and CodeForge-v2 (dogfood only); MVP gate = small tier plus CodeForge-v2 | BT / HR / DEF | NFR-060..066 | — |
| DEC-11 | License undecided. No LICENSE file. CodeForge's license does not apply automatically. | DEF | NFR-070 | [0013](ADR/0013-license.md) |
| DEC-12 | Phase 00 must not expand into implementation work | HR | NFR-044 | — |

## 2. Functional requirements

### 2.1 Workspace and file intelligence

| ID | Requirement | Tag | Phase |
|---|---|---|---|
| FR-001 | Index exactly one workspace root per runtime instance and persist its identity in `.cie/workspace.json` | HR | 01 |
| FR-002 | Enumerate files deterministically: the same tree plus the same config gives the same file set and order | HR | 01 |
| FR-003 | Apply ignore rules from `.gitignore`, CIE defaults (`node_modules`, `.git`, `.cie`, build outputs) and the repo config `cie.config.json` (non-sensitive allow-list of keys only) | HR | 01 |
| FR-004 | Canonicalize paths to workspace-relative, `/`-separated, normalized form. Reject paths and symlinks that escape the root. | HR | 01 |
| FR-005 | Record per-file content hash (SHA-256), size, language and detected encoding | HR | 01 |
| FR-006 | Produce folder and module structure nodes: directories, packages (`package.json`), Python packages (`__init__.py`), TS project roots (`tsconfig.json`) | HR | 01 |
| FR-007 | Skip files above a configurable size limit and binary files, and record them as `skipped` with a reason | HR | 01 |

### 2.2 Code intelligence

| ID | Requirement | Tag | Phase |
|---|---|---|---|
| FR-020 | Extract symbols (module, class, function, method, interface, type alias, enum, variable/constant, property) with definition ranges for TS/JS (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`) | HR | 02 |
| FR-021 | Extract symbols for Python (`.py`, `.pyi`): module, class, function, method, module-level assignment | HR | 02 |
| FR-022 | Resolve TS/JS imports to files and symbols, including `tsconfig` `paths`/`baseUrl` and package `exports` within the workspace, at L3 fidelity | HR | 02 |
| FR-023 | Resolve TS/JS references, call edges (static), `extends`/`implements` at L3 via the TypeScript compiler API | HR | 03 |
| FR-024 | Resolve Python imports at L2 (heuristic module resolution). Python references and calls are L2 and are recorded as `inferred`. | HR | 03 |
| FR-025 | Expose a capability and fidelity profile per language and capability. Queries report the fidelity of their results. | HR | 02 |
| FR-026 | Represent unresolvable constructs (dynamic import with a non-literal argument, reflection, `getattr`, DI containers) as `unknown` or unresolved, never as fabricated edges | HR | 02 |
| FR-027 | Dart support through the same adapter port | DEF | post-MVP |
| FR-028 | Optional SCIP import as a precise-reference enricher | DEF | 08+ |

### 2.3 Knowledge graph and provenance

| ID | Requirement | Tag | Phase |
|---|---|---|---|
| FR-030 | Store nodes (file, directory, module, package, symbol, concept, architecture component, wiki page) and typed relations with defined semantics | HR | 03 |
| FR-031 | Every claim has a status in `verified \| inferred \| user_asserted \| unknown` and a freshness in `current \| stale` | HR | 03 |
| FR-032 | Every claim has at least one evidence item or an explicit "no evidence" marker. `verified` requires deterministic evidence. | HR | 03 |
| FR-033 | User-authored concepts and relations are declared in repo Markdown front matter and imported as `user_asserted` | HR | 04 |
| FR-034 | Bounded graph queries: neighbors, paths and closures with depth and result limits | HR | 03 |
| FR-035 | Architecture model: components from package/folder boundaries plus optional user-declared layers and rules; report dependency-rule violations as verified claims | HR | 08 |
| FR-036 | Execution-flow traces along call edges from an entry symbol, with per-edge status and a flow-level confidence summary | HR | 08 |

### 2.4 Documentation

| ID | Requirement | Tag | Phase |
|---|---|---|---|
| FR-040 | Curated wiki pages live in the repo (default `docs/wiki/`, configurable) | HR | 04 |
| FR-041 | Generated drafts, caches and the SQLite index live in `.cie/`, which is git-ignored by default | HR | 04 |
| FR-042 | Publishing generated pages to the repo is opt-in (`wiki.publishGenerated`) | HR | 04 |
| FR-043 | Pages have a stable `id` in front matter. Sections are user-owned unless enclosed in `cie:begin`/`cie:end` markers. | HR | 04 |
| FR-044 | Deterministic, template-based generated sections (symbol tables, dependency lists, file inventories) are available **without an LLM** | HR | 04 |
| FR-045 | Detect broken and stale links and stale generated sections per revision, and report them | HR | 04–05 |
| FR-046 | A conflict workflow applies when a generated section was edited by a user: record the conflict, write the proposal to `.cie/conflicts/`, and never overwrite | HR | 04 |

### 2.5 Synchronization

| ID | Requirement | Tag | Phase |
|---|---|---|---|
| FR-050 | Full index into a staging revision, then publish atomically | HR | 01 |
| FR-051 | Incremental indexing from change hints (watcher, extension events, explicit paths), verified by content hash | HR | 05 |
| FR-052 | Periodic and on-demand reconciliation scans to catch missed watcher events | HR | 05 |
| FR-053 | Symbol lineage across revisions: unchanged, modified, moved, renamed or deleted | HR | 05 |
| FR-054 | Staleness propagation: changed sources make dependent claims and sections stale | HR | 05 |
| FR-055 | Single-writer lease per workspace. Interrupted jobs recover on restart. | HR | 01 |
| FR-056 | Cancellation of running index jobs | HR | 01 |

### 2.6 AI-assisted documentation

| ID | Requirement | Tag | Phase |
|---|---|---|---|
| FR-060 | `LlmProvider` port owned by CIE. Ollama is the default adapter. | HR | 07 |
| FR-061 | OpenAI-compatible adapter, available only with explicit per-workspace consent stored **outside** the workspace | HR | 07 |
| FR-062 | Mandatory secret redaction and secret-file exclusion before any cloud call | HR | 07 |
| FR-063 | LLM output is schema-validated. It may cite only anchor and claim IDs supplied in the prompt and supports an `insufficient_evidence` answer. | HR | 07 |
| FR-064 | LLM-derived claims are always `inferred` | HR | 07 |
| FR-065 | Generated prose sections record model ID, prompt template version, input hash and source claim IDs | HR | 07 |
| FR-066 | All non-prose capabilities work with `llm.provider = none` | HR | 01+ |

### 2.7 Public API, CLI and integration

| ID | Requirement | Tag | Phase |
|---|---|---|---|
| FR-070 | JSON-RPC 2.0 over stdio server on the runtime | HR | 06 |
| FR-071 | Query profile: read-only methods for symbols, references, dependencies, concepts, architecture, impact, flows, wiki and evidence | HR | 06 (subset) / 09 (complete) |
| FR-072 | Control profile: index, cancel, generate and publish. Available only to local trusted clients, never through MCP by default. | HR | 06 |
| FR-073 | Every response carries `apiVersion`, `revision {id, seq, freshness}` and bounded pagination | HR | 06 |
| FR-074 | Deadlines (`_meta.deadlineMs`) and cancellation (`$/cancelRequest`) | HR | 06 |
| FR-075 | Versioned `@cie/protocol` package with zero dependencies | HR | 06 |
| FR-076 | MCP server adapter over the same query layer, read-only tools and resources | HR | 09 |
| FR-077 | Public CLI: `cie init`, `cie index`, `cie status`, `cie query …`, `cie serve --stdio`, `cie mcp` | HR | 09 (dev CLI from 01) |
| FR-078 | HTTP transport | DEF | post-MVP |
| FR-079 | `@cie/client`, a typed stdio client used by the extension and by external adapters (e.g. CodeForge) | HR | 06 |

### 2.8 VS Code extension

| ID | Requirement | Tag | Phase |
|---|---|---|---|
| FR-080 | Spawn and supervise the runtime on system Node. Never load native modules in the extension host. | HR | 06 |
| FR-081 | Wiki Explorer (TreeView), Architecture Explorer (TreeView), Search (QuickPick), Wiki panel (React Webview) | HR | 06 (Architecture: 08) |
| FR-082 | Concept cards in a bottom sheet inside the Webview, plus a native editor HoverProvider for symbols | HR | 06 |
| FR-083 | Symbol-accurate navigation through anchor resolution plus a document-symbol cross-check, never a raw stored line | HR | 06 |
| FR-084 | Sync status in the status bar (current / indexing / stale / error) | HR | 06 |
| FR-085 | The Webview has no storage or filesystem access. All data flows through a typed, host-validated message protocol. | HR | 06 |

## 3. Non-functional requirements

### 3.1 Documentation and process

| ID | Requirement | Tag |
|---|---|---|
| NFR-001 | All planning and design docs are in English | HR |
| NFR-002 | Statements are labeled Fact / Assumption / Proposal / Open | HR |

### 3.2 Architecture and deployment

| ID | Requirement | Tag |
|---|---|---|
| NFR-010 | Domain and application layers (`@cie/core`) have no dependency on VS Code, CodeForge, LLM SDKs, SQLite, UI frameworks, build tools or Node built-ins | HR |
| NFR-011 | The core is transport-agnostic. Transports are adapters in `@cie/runtime` / `@cie/mcp`. | HR |
| NFR-012 | MVP deployment is a separate local process on system Node | HR |
| NFR-013 | In-process deployment (e.g. inside the extension host) | DEF |
| NFR-014 | Modular monolith. No microservices and no distributed messaging. | HR |
| NFR-015 | Local-first and offline-capable. No network calls unless a cloud LLM is explicitly enabled. | HR |

### 3.3 Data integrity and reliability

| ID | Requirement | Tag |
|---|---|---|
| NFR-020 | The derived index can be rebuilt from source plus repo Markdown alone | HR |
| NFR-021 | Corruption is detected on open, and the derived DB is quarantined and rebuilt | HR |
| NFR-022 | Forward-only, contiguous migrations for `state.db`. `index.db` may be rebuilt on a schema change. | HR |
| NFR-023 | Deterministic output: the same inputs and configuration give byte-identical exports | HR |

### 3.4 Security

| ID | Requirement | Tag |
|---|---|---|
| NFR-030 | All repository content is untrusted input | HR |
| NFR-031 | CIE never executes repository code and never writes outside `.cie/` and the configured wiki directory | HR |
| NFR-032 | Security-sensitive settings (LLM provider, endpoint, consent, publish target) are never read from repo-committed files | HR |
| NFR-033 | Instructions embedded in repo content never alter CIE behavior, policies or tool permissions | HR |

### 3.5 Governance

| ID | Requirement | Tag |
|---|---|---|
| NFR-040 | `invariants.yaml` and `invariants.schema.json` exist from Phase 00 and are validated in CI | HR |
| NFR-041 | CI fails if a CRITICAL ACTIVE invariant with `phase ≤ current` has no test file, or if its test fails | HR |
| NFR-042 | Blocking fitness functions run on every PR on Windows and Linux | HR |
| NFR-043 | Invariants are never deleted, only `DEPRECATED` | HR |
| NFR-044 | Phase 00 is limited to scaffold, governance wiring, domain primitive types and empty ports | HR |

### 3.6 Tooling

| ID | Requirement | Tag |
|---|---|---|
| NFR-050 | npm workspaces, TypeScript strict ESM (`NodeNext`), Vitest, ESLint 9 flat config, dependency-cruiser | PREF |
| NFR-051 | React + TypeScript Webview built with Vite. Extension host bundled with esbuild. | PREF |
| NFR-052 | UI and build-tool dependencies are confined to `packages/vscode-extension` and root dev tooling | HR |
| NFR-053 | Node version: a currently supported LTS, verified against dependencies, recorded in ADR-0004 and enforced via `engines` and the CI matrix | HR |
| NFR-054 | Exact pinned dependency versions (`save-exact`) and a committed lockfile | HR |
| NFR-055 | CI on `windows-latest` and `ubuntu-latest` | HR |

### 3.7 Benchmarks

| ID | Requirement | Tag |
|---|---|---|
| NFR-060 | Three benchmark tiers: small, medium, large/scaling | BT |
| NFR-061 | Candidate fixtures: Zod, Requests (small); Django (medium); TypeScript (large); synthetic generator (scaling); CodeForge-v2 (dogfood) | BT |
| NFR-062 | Metric families: functional correctness, performance, intelligence quality | BT |
| NFR-063 | The full benchmark strategy is documented before Phase 01 | HR |
| NFR-064 | MVP acceptance requires only the small tier plus CodeForge-v2 | HR |
| NFR-065 | Medium and large tier gating | DEF (phased in after MVP) |
| NFR-066 | No numeric performance threshold without a recorded baseline and variance measurement | HR |

### 3.8 Licensing

| ID | Requirement | Tag |
|---|---|---|
| NFR-070 | License choice (Apache-2.0 / MIT / proprietary) | DEF ([ADR-0013](ADR/0013-license.md), OQ-01) |
| NFR-071 | Third-party dependency licenses are inventoried before any distribution. Dependencies known at planning time (E-02..E-17) are MIT or Apache-2.0. | HR |

## 4. Traceability

- Invariant to requirement mapping: [DOMAIN_INVARIANTS.md §10](DOMAIN_INVARIANTS.md#10-traceability).
- Requirement to phase mapping: the **Phase** column above. Acceptance per phase: [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md).
