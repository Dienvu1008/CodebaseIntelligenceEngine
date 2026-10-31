# Risks, Open Questions, and Critical Architecture Review

> Status: Baseline v0.1

## 1. Risks

Likelihood (L) and Impact (I) are rated H, M or L. Risks marked ⚠ could **invalidate a core architectural decision**.

| ID | Risk | L | I | Mitigation | Trigger → response |
|---|---|---|---|---|---|
| R-01 | Users lack system Node ≥24, so out-of-process adoption friction is high | M | M | Clear diagnostics; `cie.nodePath`; bundled-runtime VSIX option (OQ-06) | Adoption feedback → prioritize platform VSIX bundling |
| R-02 ⚠ | Tree-sitter WASM/ABI mismatch between web-tree-sitter 0.27 and the grammar `.wasm` builds (A-01; precedent E-26) | M | M | Spike S2; vendored grammar builds (ADR-0010 option C) | S2 fails → vendored builds; cost is CI complexity, not architecture |
| R-03 ⚠ | TypeScript 7 (native) changes or removes the JS compiler API that `lang-ts` relies on (ADR-0016) | M | H | Isolated in `ProjectResolver`; pinned TS version; fallbacks are scip-typescript import (ADR-0011) or a TS-LSP resolver | TS 7 release notes → dedicated ADR before upgrading. **Update (Phase 00, E-32):** TS 7.0.2 is released. CIE pins 6.0.3 (tooling peer ranges). Phase 02 must check whether `typescript@6` stays maintained, and whether TS 7 exposes a usable programmatic API for `lang-ts`, before ADR-0016 is re-confirmed. |
| R-04 ⚠ | `better-sqlite3` prebuilds are missing for a target Node or platform (A-02) | L | H | Spike S1; `node:sqlite` adapter fallback (E-08) behind the same ports | S1 fails → implement the `node:sqlite` adapter |
| R-05 | TS `Program` memory on large monorepos | M | M | Sequential per-tsconfig programs; release after use; benchmark FF-PRF-002 | Medium/large tier OOM → project sharding, or SCIP import as the batch path |
| R-06 | Edge volume (references per occurrence) inflates `index.db` size and publish time | M | M | Occurrence ranges as attributes on aggregated `(from, to, type)` edges [Proposal]; measure in Phase 03 | DB size regression → aggregate occurrences or move them to a side table |
| R-07 | File watcher drops events (esp. Windows, large bursts) | H | M | Hints-only model; reconciliation; freshness `unknown` (SN-001) | Detected via reconciliation discrepancy counters |
| R-08 | Windows path edge cases (case-insensitivity, 8.3 names, `\\?\`, UNC, ADS, reserved names) | M | H | WS-002 vectors; cross-platform CI | New vector → add to the suite |
| R-09 | Lineage false positives (two similar bodies → wrong rename match) | M | M | Require kind + container + fingerprint; ambiguity → `deleted` + suggestions, never a guess | Drift-script failures |
| R-10 | Local LLM quality too low for useful prose | M | L (MVP has no LLM) | Quality protocol; opt-in cloud with consent; template sections remain the baseline | Acceptance-rate metric |
| R-11 | Accessibility gaps in the custom bottom sheet | M | M | Native TreeView/QuickPick/hover alternatives; axe checks; manual audit | Audit findings block the Phase 06 exit |
| R-12 | MCP specification churn (E-09) | H | L | MCP isolated in `@cie/mcp`; spec pinned at Phase 09 entry | New spec → adapter update only |
| R-13 ⚠ | Validity-interval model complexity causes subtle visibility bugs | M | H | One query builder for the visibility predicate (FF-BND-003); SN-003/SN-007 digest tests; crash injection | Any digest mismatch is a release blocker |
| R-14 | Scope creep in Phase 00 (implementing features early) | M | M | Phase 00 checklist `scope_rule`; sign-off review | — |
| R-15 | Single-maintainer tooling (ArchUnitTS, E-12) | M | L | Advisory only; custom-script fallback | Unmaintained → drop |
| R-16 | Heuristic Python edges mislead users despite labels | M | M | Status badges and fidelity always shown; impact results report the weakest status | User feedback / quality metrics |

## 2. Open questions and deferred decisions

| ID | Question | Class | Owner / when |
|---|---|---|---|
| OQ-01 | License: Apache-2.0, MIT, proprietary, or split (ADR-0013) | DEF | Stakeholder, before any publication |
| OQ-02 | In-process deployment mode (ADR-0002) | DEF | Revisit when `node:sqlite` is stable in both the extension host and the LTS |
| OQ-03 | HTTP transport (ADR-0003) | DEF | On concrete multi-client need |
| OQ-04 | Embeddings and semantic search (`SemanticIndex` port) | DEF | Post-Phase 09; needs a local embedding model choice |
| OQ-05 | Use the workspace's own TypeScript version instead of the pinned one | Open | Phase 02 |
| OQ-06 | Ship a platform-specific VSIX with a bundled runtime (A-05) | Open | Phase 06 stretch |
| OQ-07 | JSON-RPC framing: newline-delimited vs `Content-Length` headers | Open | Phase 06 (the recommendation leans to `Content-Length` for LSP-tooling familiarity) |
| OQ-08 | ESLint 9 vs 10 (A-08) | **Resolved (Phase 00):** stay on ESLint 9.39.5; typescript-eslint supports both (ADR-0005) | — |
| OQ-09 | Installing grammar packages without their native install scripts | Open | Phase 02 (spike S2) |
| OQ-10 | Adopt ArchUnitTS for coupling metrics, or custom scripts | **Resolved (Phase 00):** not adopted; `depcruise --metrics` (ARCHITECTURE_FITNESS §1) | — |
| OQ-11 | `@cie/client` minimum Node (CodeForge declares ≥20, E-20) | Open | Phase 06 / 10 |
| OQ-12 | Allow read-only `git` invocation (SEC-002 register) | Open | Phase 05 |
| OQ-13 | Dedicated benchmark runner vs reference developer machine | Open | Phase 01 |
| OQ-14 | Absolute product performance targets (interactive latency etc.) | Open | After the Phase 05 baselines, with the stakeholder |
| OQ-15 | Dart support timing (ADR-0006) | DEF | After Phase 08 |
| OQ-16 | Multi-root workspaces: cross-folder links | DEF | Post-MVP |
| OQ-17 | Branch-aware indexes (index per branch vs reindex on switch) | DEF | Post-MVP (B-08 measures the cost first) |
| CFQ-1..5 | CodeForge-side questions | Not CIE decisions | CODEFORGE_INTEGRATION §7 |

## 3. Critical architecture review (brief §15)

| Question | Answer | Evidence in package |
|---|---|---|
| **Is the domain model unnecessarily complicated?** | It was simplified deliberately. There are **six aggregates** (Workspace, IndexRevision, IndexJob, KnowledgeClaim, Concept, WikiPage). Bulk structural facts are revision-scoped records validated in bulk, not aggregates. RepositorySnapshot and DocumentationRevision were demoted. Provenance was merged into Knowledge. | DOMAIN_MODEL §1–2 |
| **Are bounded contexts justified?** | Five contexts. Each has distinct invariants (WS, SY/KG, PV, DOC, SN) and a distinct change driver. "Integration/Query" was rejected as a domain because it has no own invariants. The shared kernel is allow-listed. | BOUNDED_CONTEXTS §1, §4 |
| **Are invariants enforceable?** | Yes. Each one names a concrete mechanism (domain, db, validator, type, adapter, ci) and a test path, and governance CI enforces test presence. Limit: SEC-001 effectiveness is testable but not provable (stated). | DOMAIN_INVARIANTS, SECURITY §4 |
| **Are fitness functions executable?** | Yes. Every blocking FF names a tool and a CI job, and has a self-test with violation fixtures. Performance FFs are either structural (counts, query plans) or regression-vs-baseline, and none use invented thresholds. | ARCHITECTURE_FITNESS §2–5 |
| **Do dependencies point in the correct direction?** | Yes. Core and protocol are leaves (no npm, no `node:*`). Adapters depend on core. Runtime composes. Clients depend only on protocol. Context order is acyclic. These are enforced by FF-DEP-001/002 and FF-BND-001/002. | DEPENDENCY_RULES §1–3 |
| **Can the engine run without VS Code?** | Yes. The CLI and `@cie/client` use the same `ProtocolHandler`, and FF-DEP-003 bans `vscode` outside the extension host. | SYSTEM_ARCHITECTURE §8 |
| **Can it operate without an LLM?** | Yes. `llm-none` is the default, template generators exist, and AI-004 runs the CI suite with no LLM. The MVP (00–06) contains no LLM features at all. | ADR-0009, ROADMAP Phase 06 |
| **Can it support multiple languages?** | Yes, at **declared** fidelity. Two ports (`FileExtractor`, `ProjectResolver`), a capability matrix exposed in the API, and Python proving the abstraction in the MVP. It is not identical semantics, by design. | CODE_INTELLIGENCE_STRATEGY §4–5 |
| **Can indexing recover after interruption?** | Yes. Staging revisions, lease expiry, RecoveryService (abandon or resume), crash-injection tests, and quarantine plus rebuild for corruption. | SN-005, SECURITY §3.2–3.3 |
| **Can documentation remain trustworthy after extensive code modification?** | Partially, and the limits are explicit. Generated sections are tracked and staled (DOC-006). Links are redirected, staled or broken (DOC-004). Anchors are resolved through lineage and live cross-checks. But **user prose cannot be verified**: CIE only flags "documented code changed", and identity loss (rename and body rewrite together) is reported, never guessed. | DOCUMENTATION_MODEL §7, §11 |
| **Can CodeForge consume it without architectural coupling?** | Yes. The adapter lives in CodeForge, the mapping is complete, CIE has zero CodeForge imports (FF-DEP-004), and output is advisory and untrusted. | CODEFORGE_INTEGRATION |
| **Can the project evolve without becoming a god object?** | Guarded by: the shared-kernel allow-list; the ban on `utils`/`common` folders; per-context `public.ts` barrels; FF-CPX-001 module-size and complexity ratchets; coupling reports at each sign-off; segregated query ports instead of one `KnowledgeProvider` god interface. | ARCHITECTURE_FITNESS §3.3, PUBLIC_API_CONTRACT §1 |

## 4. Contradiction log

These contradictions were found during the final cross-document pass and resolved in this baseline.

| ID | Contradiction | Resolution | Docs updated |
|---|---|---|---|
| C-01 | Core ports used `AbortSignal`, but the core may not use Node or DOM lib types (FF-DEP-002b, ES2022 lib only) | A structural `CancellationSignal` type was added to the shared kernel. `AbortSignal` satisfies it, and adapters and the runtime pass real signals. | BOUNDED_CONTEXTS §4, CODE_INTELLIGENCE_STRATEGY §4, ADR-0002, ADR-0009, ROADMAP Phase 00, phase_00_checklist |
| C-02 | The incremental algorithm "updated the range in place" for shifted symbols, which violates SN-007 immutability. Edges keyed by row ID would also dangle when a node got a new version (KG-001). | Append-only `node_key`/`file_key` identity tables were introduced. Versioned rows reference keys, and shifted symbols get a new version row. | KNOWLEDGE_GRAPH_DESIGN §5, §7, §8.3, §9; DOCUMENTATION_MODEL §9; ADR-0015; DOMAIN_INVARIANTS KG-001 |
| C-03 | WS-001 required every evidence locator to reference a file visible at the same revision. That made historical evidence (needed for PV-004 staleness detection) a violation. | WS-001 was split: (a) structural records must be visible at the same seq; (b) explicit evidence and anchors reference a known `file_key` plus the observed `contentHash`, and freshness is decided by PV-004/SN-008. | DOMAIN_INVARIANTS WS-001, invariants.yaml, KNOWLEDGE_GRAPH_DESIGN §9 |
| C-04 | `spanHash` was defined as a hash of raw file bytes (SY-003) and also as a hash of the UTF-8 span text (CODE_INTELLIGENCE §6) | The definition is now the UTF-8 encoding of the decoded span text, which is platform- and encoding-independent | DOMAIN_INVARIANTS SY-003, invariants.yaml |
| C-05 | SEC-002 confines writes to `.cie/` and `wiki.dir`, but `cie init` edits `.gitignore`, benchmarks need `--state-dir`, and consent is written to the user config dir | A SEC-002 write-exception register was added, with an explicit authorization for each exception | SECURITY_AND_RELIABILITY §2, DOMAIN_INVARIANTS SEC-002, invariants.yaml, ADR-0007 |
| C-06 | The plan said both JSON-RPC and MCP are adapters "over the same read-only query layer", but JSON-RPC also carries control methods | The query layer is shared and read-only. Control methods are a separate profile, available on JSON-RPC only to trusted local clients and never on MCP (SEC-004). | PUBLIC_API_CONTRACT §2 |
| C-07 | Brief Phase 09 is "Public API and CLI", but the Phase 06 extension already needs JSON-RPC and a client, and earlier phases need a CLI for dogfooding | A dev CLI is available from Phase 01. JSON-RPC, `@cie/client` and protocol v1-pre arrive in Phase 06. Phase 09 freezes v1.0, finalizes the public CLI and adds MCP. | IMPLEMENTATION_ROADMAP, REQUIREMENTS FR-070..079 |
| C-08 | The brief lists "Provenance and Evidence" as a context, while PV-001 requires claim and evidence consistency in one transaction | Provenance was merged into Knowledge, and its vocabulary is published for the other contexts | BOUNDED_CONTEXTS §1 |
| C-09 | The brief's `KnowledgeProvider` returns bare arrays and non-nullable `getSymbol` | Envelope plus pagination plus nullable results, and segregated ports | PUBLIC_API_CONTRACT §1, §4 |
| C-10 | The brief preferred inheriting CodeForge's Node 20 baseline, but Node 20 is EOL (E-01) | Node `>=24 <27`, with a CI matrix of 24 and 26 (ADR-0004) | ADR-0004, REQUIREMENTS NFR-053 |
| C-11 | (Found in Phase 00 closure.) "CI fails if an invariant with `phase ≤ current` has no test" would make a phase red from its first commit, because its invariant tests are written *during* the phase | `current_phase` = the phase in progress. Completed phases (`<`) are hard gates; in-progress invariants are warnings; bumping `current_phase` closes a phase and requires its gate to be green | `scripts/check-governance.mjs`, `governance/phase.yaml`, REQUIREMENTS NFR-041, DOMAIN_INVARIANTS §1, ADR-0012 |

## 5. Readiness statement (honest)

**Ready:**
- Architecture, bounded contexts, domain model, invariants (49, machine-readable), dependency rules, fitness functions, API contract, integration strategy, security model, test and benchmark methodology, and a phased roadmap with acceptance and exit criteria.
- Phase 00 is fully specified by its checklist. Phase 01 is specified down to modules, schema, invariants and acceptance tests.

**Not yet established** (these must not be glossed over):
1. **Spikes S1 (SQLite / Node 24 & 26 / FTS5) and S2 (tree-sitter WASM ABI) have not been run.** ADR-0004, ADR-0008 and ADR-0010 are conditional on them, and fallbacks are defined.
2. Exact dependency versions are not pinned. This is a Phase 00 task.
3. Benchmark fixture SHAs are not selected (Phase 01), and tier assignments for CodeForge-v2 and TypeScript are assumptions.
4. Performance targets do not exist by design until the baselines exist (OQ-14).
5. The license is undecided (OQ-01). It does not block implementation, but it blocks distribution.
6. Several schema and algorithm details (FTS head-only semantics, occurrence aggregation R-06, lineage thresholds) are [Proposal]s that Phase 02–05 tests may revise through ADRs.
7. Accessibility has been designed for but not validated. WCAG conformance requires manual assistive-technology testing and expert review.
