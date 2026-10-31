# ADR-0001: Modular Monolith with Hexagonal Layers

- **Status:** Accepted (planning baseline)
- **Date:** 2026-10-31
- **Related:** NFR-010, NFR-014, [BOUNDED_CONTEXTS](../BOUNDED_CONTEXTS.md), [DEPENDENCY_RULES](../DEPENDENCY_RULES.md)

## Context

- CIE runs on a single developer machine, against one workspace per process. There is no multi-tenant or horizontal-scaling requirement (PROJECT_VISION §5).
- The domain has real boundaries: workspace, code intelligence, knowledge, documentation and synchronization. Those boundaries are about **consistency and ownership**, not about deployment.
- [Fact] CodeForge-v2 shows a working precedent: a single-process TypeScript monorepo with a pure domain package plus an adapters package, with boundaries enforced by ESLint and dependency-cruiser (E-20, E-22).
- Indexing is CPU- and IO-bound locally. Network hops between services would add latency and failure modes without any benefit.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Modular monolith (packages + internal contexts, enforced boundaries) | One process; transactions span contexts where needed; simple debugging; extraction remains possible | Boundary erosion if not enforced, which is mitigated by fitness functions |
| B. Microservices (indexer, graph, docs, API) | Independent deployability | No deployment need; distributed consistency of revisions becomes hard; ops burden contradicts local-first |
| C. Single package without internal boundaries | Fastest start | God-object risk; violates O8 |

## Decision

**Option A.** CIE is a modular monolith organized as npm workspace packages:

- `@cie/protocol`, `@cie/core`, `@cie/adapters`, `@cie/runtime`
- `@cie/client`, from Phase 06
- `@cie/mcp`, from Phase 09
- `cie-vscode`

Inside `@cie/core`, each bounded context is a folder with `domain/`, `application/` and a single `public.ts` barrel. Cross-context access goes only through `public.ts`, and dependency-cruiser enforces this (FF-BND-001).

## Consequences

- Positive:
  - Atomic revision publishing can use one SQLite transaction (SN-003).
  - Testing is simple.
- Negative: boundary discipline must be automated, which is paid for in Phase 00 (FF-DEP-*, FF-BND-*).
- Extraction path: any context whose application services are reached only through ports can later move behind a transport. `@cie/protocol` already defines the wire contract for the query side.

## Evidence

E-20, E-22.

## Revisit trigger

Revisit if a measured requirement emerges for shared or remote indexing, such as a team server or CI-produced indexes consumed by many clients.
