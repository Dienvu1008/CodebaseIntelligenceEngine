# Codebase Intelligence Engine (CIE): Planning Package

> Status: **Baseline v0.1 (planning only)**. Date: 2026-10-31.
> No product code exists. This package defines the architecture, domain, invariants, governance and roadmap that a separate implementation phase will build.

## 1. Reading order

| # | Document | Purpose |
|---|---|---|
| 1 | [PROJECT_VISION.md](PROJECT_VISION.md) | Why CIE exists, objectives O1–O8, non-goals |
| 2 | [REQUIREMENTS.md](REQUIREMENTS.md) | Classified functional and non-functional requirements, decision register |
| 3 | [EVIDENCE.md](EVIDENCE.md) | Evidence register (E-xx) cited by every Fact |
| 4 | [BOUNDED_CONTEXTS.md](BOUNDED_CONTEXTS.md) | The five bounded contexts, context map, merge/split rationale |
| 5 | [DOMAIN_MODEL.md](DOMAIN_MODEL.md) | Entities, value objects, aggregates, services, events, ports |
| 6 | [DOMAIN_INVARIANTS.md](DOMAIN_INVARIANTS.md) | Hard invariants and recommendations, with owners, enforcement and tests |
| 7 | [SYSTEM_ARCHITECTURE.md](SYSTEM_ARCHITECTURE.md) | Layers, runtime topology, data flows, repository structure, port catalog |
| 8 | [DEPENDENCY_RULES.md](DEPENDENCY_RULES.md) | Allowed and forbidden dependencies |
| 9 | [ARCHITECTURE_FITNESS.md](ARCHITECTURE_FITNESS.md) | Executable fitness functions and CI wiring |
| 10 | [CODE_INTELLIGENCE_STRATEGY.md](CODE_INTELLIGENCE_STRATEGY.md) | Tree-sitter, TS compiler API, LSP, SCIP; LanguageAdapter; capability matrix |
| 11 | [KNOWLEDGE_GRAPH_DESIGN.md](KNOWLEDGE_GRAPH_DESIGN.md) | Node and relation types, claims, revision scoping, SQL schema, query plans |
| 12 | [DOCUMENTATION_MODEL.md](DOCUMENTATION_MODEL.md) | Markdown wiki model, ownership, links, staleness, examples |
| 13 | [VSCODE_EXTENSION_DESIGN.md](VSCODE_EXTENSION_DESIGN.md) | Extension as adapter, Webview, bottom sheet, navigation |
| 14 | [PUBLIC_API_CONTRACT.md](PUBLIC_API_CONTRACT.md) | Versioned read-only query API, JSON-RPC, MCP mapping |
| 15 | [CODEFORGE_INTEGRATION.md](CODEFORGE_INTEGRATION.md) | How CodeForge-v2 can consume CIE without coupling |
| 16 | [SECURITY_AND_RELIABILITY.md](SECURITY_AND_RELIABILITY.md) | Threat model, reliability and recovery |
| 17 | [TEST_STRATEGY.md](TEST_STRATEGY.md) | Test layers and suites |
| 18 | [BENCHMARK_STRATEGY.md](BENCHMARK_STRATEGY.md) | Benchmark methodology, tiers, fixtures, metrics |
| 19 | [IMPLEMENTATION_ROADMAP.md](IMPLEMENTATION_ROADMAP.md) | Phases 00–10 with acceptance and exit criteria |
| 20 | [RISKS_AND_OPEN_QUESTIONS.md](RISKS_AND_OPEN_QUESTIONS.md) | Risks, open decisions, critical architecture review, contradiction log |
| — | [ADR/](ADR/) | Architecture Decision Records 0000–0016 |
| — | [governance/](governance/) | Machine-readable `invariants.yaml`, `invariants.schema.json`, `phase_00_checklist.yaml` |

An implementer starting **Phase 00 / Phase 01** needs, at minimum, these documents: 2, 4, 5, 6, 7, 8, 9, 19 and the `governance/` files.

## 2. Statement labels

Every non-trivial statement in this package carries one of these labels:

| Label | Meaning |
|---|---|
| **[Fact]** | Verified. Must cite an evidence ID (`E-xx`) from [EVIDENCE.md](EVIDENCE.md). |
| **[Assumption]** | Believed true but not verified. Each assumption has a verification point (phase or spike). |
| **[Proposal]** | A design choice made by this package. Can be changed through an ADR. |
| **[Open]** | An unresolved question. It is tracked in [RISKS_AND_OPEN_QUESTIONS.md](RISKS_AND_OPEN_QUESTIONS.md). |

Statements without a label are definitions or explanations.

## 3. Requirement classification tags

| Tag | Meaning |
|---|---|
| **[HR]** | Hard requirement. Violating it fails acceptance. |
| **[PREF]** | Preference. It is the default and can be changed with an ADR, without renegotiating scope. |
| **[BT]** | Benchmark target. It is measured, and numbers are set only after a baseline exists. |
| **[DEF]** | Deferred decision. It is explicitly not decided now and has a revisit trigger. |

## 4. Identifier conventions

| Prefix | Used for | Example |
|---|---|---|
| `FR-` / `NFR-` | Functional and non-functional requirements | `FR-012` |
| `DEC-` | Recorded stakeholder decisions | `DEC-03` |
| `WS-` | Workspace invariants | `WS-002` |
| `SY-` | Symbol invariants | `SY-001` |
| `KG-` | Knowledge graph invariants | `KG-001` |
| `PV-` | Provenance invariants | `PV-002` |
| `SN-` | Synchronization invariants | `SN-003` |
| `DOC-` | Documentation invariants | `DOC-002` |
| `AI-` | AI invariants | `AI-001` |
| `SEC-` | Security invariants | `SEC-002` |
| `API-` | Public-API invariants | `API-001` |
| `FF-<area>-` | Fitness functions (DEP, BND, CPX, DAT, PRF) | `FF-DEP-001` |
| `E-` | Evidence items | `E-07` |
| `R-` / `OQ-` | Risks and open questions | `R-04`, `OQ-02` |
| `ADR-NNNN` | Architecture decisions | `ADR-0008` |

Invariant IDs follow `^[A-Z]{2,3}-[0-9]{3}$` and never change once assigned. A retired invariant is marked `DEPRECATED`; it is never deleted.

## 5. Status vocabulary

- Document status: `Draft` → `Baseline` → `Superseded`.
- ADR status: `Proposed` → `Accepted` → `Superseded by ADR-NNNN`, or `Open` when the decision is pending.
- Invariant status: `ACTIVE` or `DEPRECATED`. Severity: `CRITICAL`, `HIGH` or `MEDIUM`.

## 6. Glossary

| Term | Definition |
|---|---|
| **Workspace** | One root folder indexed by one CIE runtime instance. It has its own `.cie/` directory and databases. |
| **Index revision** | An immutable, published snapshot of all derived structural knowledge for a workspace at a change watermark. |
| **Staging revision** | A revision under construction. It is invisible to queries until published. |
| **Watermark** | The highest change-event sequence number a revision has fully processed. |
| **Claim** | A statement in the knowledge graph (a relation or attribute) with a status of `verified`, `inferred`, `user_asserted` or `unknown`. |
| **Evidence** | A deterministic or attributed record that supports a claim. It identifies its source, producer and revision. |
| **Anchor** | A durable reference to source code: `{symbolId, path, range, spanHash, revision}`. |
| **Fidelity** | How precise a language adapter is for one capability: L0 none, L1 syntactic, L2 heuristic-resolved, L3 semantic-exact. |
| **Generated section** | A marker-delimited region of a wiki page owned by the generator. Everything else is user-owned. |
| **Query profile** | The read-only subset of the API exposed to agents and MCP. |
| **Control profile** | Local commands such as index, cancel and generate. They are available only to trusted local clients (CLI, extension). |

## 7. Scope boundary of this package

- No product code, no `package.json` and no LICENSE file are created. The license is undecided; see [ADR-0013](ADR/0013-license.md).
- The CodeForge-v2 repository was inspected **read-only** as reference material and was not modified.
- Code blocks in these documents (TypeScript interfaces, SQL, depcruise rules, YAML) are **specifications** for the implementation phase. They are not product code.
