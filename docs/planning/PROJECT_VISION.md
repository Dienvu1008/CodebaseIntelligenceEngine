# Project Vision: Codebase Intelligence Engine (CIE)

> Status: Baseline v0.1 · Labels: see [README §2](README.md#2-statement-labels)

## 1. Problem

Developers and coding agents spend a large share of their effort rebuilding a mental model of a codebase. They ask where a concept lives, what depends on it, which flow reaches it, and whether the documentation is still true. Today's options fall short in different ways:

- **Static documentation** goes stale silently.
- **IDE navigation** (LSP) is precise but local. It has no concept-level knowledge and no explanations.
- **LLM-only summaries** read well but are unverifiable. They mix structural facts with guesses and do not track source changes.
- **Agent context collectors** (for example CodeForge-v2's `ContextCollector`, E-23) are bounded per task and rebuilt every run. They have no persistent, provenance-carrying knowledge.

## 2. Vision

CIE is a **local-first, independent engine**. It turns a workspace into a **living, verifiable knowledge base**: a knowledge graph of symbols, modules, concepts and architecture, where every claim carries provenance, together with an interconnected Markdown wiki that stays synchronized with the code.

Two consumers sit on the same read-only query layer:

1. **Humans**, through a VS Code extension. It offers a Wikipedia-style explorer, concept cards in a bottom sheet, architecture views and exact source navigation.
2. **Agents**, through a stable, versioned API: JSON-RPC over stdio, and MCP from Phase 09. CodeForge-v2 is the first such consumer.

> **Deterministic facts first, AI interpretation second, and every statement is labeled with which one it is.**

## 3. Strategic objectives

| ID | Objective | How this package satisfies it |
|---|---|---|
| O1 | Independent core | Pure `@cie/core` with zero runtime dependencies; transport-agnostic ([ADR-0002](ADR/0002-transport-agnostic-core-out-of-process-mvp.md), [DEPENDENCY_RULES](DEPENDENCY_RULES.md)) |
| O2 | Living documentation | Immutable index revisions, change watermarks, staleness propagation, protected user content ([DOCUMENTATION_MODEL](DOCUMENTATION_MODEL.md), SN-/DOC- invariants) |
| O3 | Code intelligence | LanguageAdapter port with per-capability fidelity: TS/JS deep, Python at a documented lower fidelity ([CODE_INTELLIGENCE_STRATEGY](CODE_INTELLIGENCE_STRATEGY.md)) |
| O4 | Knowledge graph | SQLite-backed, revision-scoped graph with typed relations and claim status ([KNOWLEDGE_GRAPH_DESIGN](KNOWLEDGE_GRAPH_DESIGN.md)) |
| O5 | Human-friendly exploration | VS Code extension: React Webview, bottom-sheet cards, TreeViews, QuickPick ([VSCODE_EXTENSION_DESIGN](VSCODE_EXTENSION_DESIGN.md)) |
| O6 | AI-assisted understanding | Optional LLM port (Ollama default). AI output is always `inferred` and never authoritative (AI- invariants) |
| O7 | Future agent integration | Versioned `@cie/protocol` DTOs, a query profile and an MCP adapter ([PUBLIC_API_CONTRACT](PUBLIC_API_CONTRACT.md), [CODEFORGE_INTEGRATION](CODEFORGE_INTEGRATION.md)) |
| O8 | Architectural sustainability | Machine-readable invariants plus fitness functions in CI from Phase 00 ([ARCHITECTURE_FITNESS](ARCHITECTURE_FITNESS.md), [governance/](governance/)) |

## 4. Target users

| User | Primary need | Primary surface |
|---|---|---|
| Developer new to a codebase | Concept-level orientation, "what is X, where is it, what uses it" | VS Code wiki and concept cards |
| Maintainer | Architecture boundaries, impact of changes, doc freshness | Architecture Explorer, impact queries, stale-doc reports |
| Technical writer or lead | Curated concept pages that do not get overwritten | Markdown pages in the repo, conflict workflow |
| Coding agent (CodeForge-v2, others) | Bounded, evidence-backed context with revision identity | Query profile over JSON-RPC or MCP |

## 5. Non-goals

These are explicit. Each one is a [HR] in [REQUIREMENTS](REQUIREMENTS.md).

1. CIE does **not** execute repository code, build scripts or tests, and it does **not** modify source files.
2. CIE is **advisory**. It has no execution authority, approval authority or policy authority.
3. CIE is **not** part of CodeForge's Governance Kernel. It has no knowledge of TaskGraph, Policy, ToolGateway or VerificationEngine.
4. CIE is **not** a cloud service. It is not multi-tenant and has no hosted backend.
5. CIE does **not** promise identical semantic depth for every language. Fidelity is declared per language and per capability.
6. CIE does **not** replace LSP-based editor navigation. It adds persistent, concept-level knowledge on top.
7. The MVP does not include microservices, a distributed event bus, an HTTP server, embeddings or vector search.

## 6. Success criteria

The **planning** baseline (this package) succeeds when another agent can start Phase 00 and Phase 01 using only [IMPLEMENTATION_ROADMAP](IMPLEMENTATION_ROADMAP.md), [governance/](governance/) and the documents they reference, without redesigning boundaries, invariants or integration.

The **MVP** (end of Phase 06) succeeds when all of the following hold on the small benchmark tier and on CodeForge-v2 as a dogfood fixture:

- A developer can open the CIE wiki in VS Code, search for a symbol or concept, open a concept card, and jump to the **current** location of the symbol after the code has been edited, renamed or moved.
- The index stays current through incremental synchronization, and its freshness state is visible.
- Every claim shown to the user displays its status (`verified`, `inferred`, `user_asserted` or `unknown`) and its evidence.
- Everything above works with **no LLM configured**.
- Every CRITICAL invariant up to Phase 06 has a passing test, and all blocking fitness functions are green on Windows and Linux.

## 7. Guiding principles

1. **Facts have an authority.** The filesystem, parsers and compilers are authoritative for structure. LLMs are never authoritative.
2. **SQLite is a cache; truth lives in source code and Markdown.** The derived index can always be rebuilt ([ADR-0008](ADR/0008-storage-sqlite-relational-graph.md)).
3. **Partial is never presented as complete.** Revisions are published atomically, and freshness is always reported.
4. **User-authored content is sacred.** Generators never silently overwrite it.
5. **Boundaries are executable.** Every architectural rule maps to a CI check or a test.
6. **Simple first.** A modular monolith, in-process events, and SQLite. Complexity has to be justified in an ADR.
