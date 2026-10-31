# ADR-0008: Storage: SQLite Relational Graph + FTS5; Markdown for Docs; JSON for Interchange

- **Status:** Accepted. Spike S1 confirmed FTS5, WAL isolation and CAS on the full CI matrix (E-33). The `node:sqlite` fallback is not needed.
- **Date:** 2026-10-31
- **Related:** [KNOWLEDGE_GRAPH_DESIGN](../KNOWLEDGE_GRAPH_DESIGN.md), SN-003, SN-007, KG-001, NFR-020..022

## Context

- **Expected query shapes.** Bounded neighborhood queries, transitive closures with depth limits (impact, flows), name and full-text search, and revision-scoped reads.
- **Requirements.** Atomic publish, crash safety, single-file local storage, Windows and Linux support, and no server process.

Facts about the candidates:

- [Fact] Kùzu, the leading embedded property-graph DB for Node, is **archived** (E-13).
- [Fact] DuckDB's SQL/PGQ extension (duckpgq) is a research-stage community extension (E-14).
- [Fact] `better-sqlite3` 13 is actively maintained, with per-platform prebuilt binaries (E-07).
- [Assumption A-03] Its bundled SQLite includes FTS5.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| **A. SQLite (better-sqlite3): adjacency tables + recursive CTEs + FTS5** | Mature, ACID, WAL readers alongside one writer, single file, synchronous API with fast batch inserts, FK constraints | Recursive CTEs are less expressive than Cypher; graph algorithms (centrality) must run in app code |
| B. Kùzu (embedded Cypher) | Native graph queries, built-in FTS and vector search | **Archived** (E-13): unacceptable maintenance risk |
| C. DuckDB + duckpgq | Strong analytics; SQL/PGQ | Research extension (E-14); OLAP engine poorly suited to many small transactional updates |
| D. Flat files (JSON / JSONL per revision) | Transparent, diffable | No indexes, no transactions, full loads for queries (contradicts "do not load the entire graph") |
| E. LevelDB/LMDB key-value + custom graph | Fast | Rebuilds SQL features by hand |
| F. sql.js (WASM SQLite) | No native module | In-memory DB, whole file rewritten on save; unsuitable for large indexes |

## Decision

**Option A** for both stores, with Markdown and JSON in their own roles:

| Format | Role |
|---|---|
| SQLite (`.cie/index.db`, derived) | Structural facts, graph, claims, evidence, FTS5 search. Accessed only through repository ports. |
| SQLite (`.cie/state.db`, local state) | Must be migrated, not rebuilt |
| Markdown | Human-readable docs (ADR-0007) |
| JSON | Portable exports (`cie export --format json`), golden-test snapshots, MCP and JSON-RPC payloads. Never the primary store. |

Semantic and vector search is **[DEF]** and is not part of the MVP. If added later, it will be an optional index (e.g. `sqlite-vec` or an external file) behind a `SemanticIndex` port.

- **Fallback if A-03 fails:** a trigram/LIKE-based search table behind the same `SearchIndex` port, plus a ticket to compile with FTS5.
- **Fallback if `better-sqlite3` fails on a target platform:** a `node:sqlite` adapter behind the same repository ports (E-08), accepting its release-candidate status.

## Consequences

- The graph schema is relational (see KNOWLEDGE_GRAPH_DESIGN §5). Every traversal has depth and limit bounds (FF-PRF-004).
- Graph algorithms beyond traversal (PageRank and similar) are computed in application code over bounded subgraphs, and only when needed (Phase 08).

## Evidence

E-07, E-08, E-13, E-14, A-03.

## Revisit trigger

- Query-latency benchmarks show recursive CTEs cannot meet targets on the medium tier.
- A maintained embedded graph DB with Node bindings appears.
