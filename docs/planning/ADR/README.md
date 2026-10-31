# Architecture Decision Records

| ADR | Title | Status |
|---|---|---|
| [0000](0000-template.md) | Template | — |
| [0001](0001-modular-monolith.md) | Modular monolith with hexagonal layers | Accepted |
| [0002](0002-transport-agnostic-core-out-of-process-mvp.md) | Transport-agnostic core, out-of-process MVP, in-process deferred | Accepted |
| [0003](0003-transport-jsonrpc-stdio-then-mcp.md) | JSON-RPC stdio for the MVP, MCP from Phase 09, HTTP deferred | Accepted |
| [0004](0004-node-lts-selection.md) | Node.js LTS selection | Accepted, pending spike S1 |
| [0005](0005-tooling-stack.md) | Tooling stack | Accepted (preference) |
| [0006](0006-language-support-priorities.md) | TS/JS deep, Python via adapter, Dart deferred | Accepted |
| [0007](0007-split-documentation-storage.md) | Split documentation storage | Accepted |
| [0008](0008-storage-sqlite-relational-graph.md) | SQLite relational graph + FTS5 | Accepted, pending spike S1 (FTS5) |
| [0009](0009-local-first-llm-policy.md) | Local-first LLM policy | Accepted |
| [0010](0010-tree-sitter-wasm-version-strategy.md) | Tree-sitter WASM and ABI strategy | Accepted; OQ-09 resolved (vendored artifacts); S2 CI matrix pending |
| [0011](0011-scip-optional-enricher.md) | SCIP as an optional enricher | Accepted (post-MVP) |
| [0012](0012-machine-readable-governance.md) | Machine-readable governance | Accepted |
| [0013](0013-license.md) | License | **Open** |
| [0014](0014-symbol-identity-and-lineage.md) | Symbol identity and lineage | Accepted |
| [0015](0015-revision-and-publish-model.md) | Revision model and atomic publish | Accepted |
| [0016](0016-typescript-semantics-compiler-api.md) | TS semantics via the compiler API | Accepted |

ADRs 0001–0013 are the foundational set requested by the plan. ADRs 0014–0016 record core mechanisms that the domain model and invariants depend on.
