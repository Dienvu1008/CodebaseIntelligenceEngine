# ADR-0002: Transport-Agnostic Core; Out-of-Process Runtime for the MVP; In-Process Deferred

- **Status:** Accepted
- **Date:** 2026-10-31
- **Related:** DEC-02, NFR-010..013, FR-080, [SYSTEM_ARCHITECTURE](../SYSTEM_ARCHITECTURE.md), [VSCODE_EXTENSION_DESIGN](../VSCODE_EXTENSION_DESIGN.md)

## Context

- **SQLite driver.** [Fact] The preferred driver, `better-sqlite3`, is a native addon. Version 13.0.3 requires Node ≥22 and ships per-platform binaries (E-07).
- **Native modules in VS Code.** [Fact] CodeForge-v2 avoids loading `better-sqlite3` inside the VS Code (Electron) extension host. It runs its runtime on system Node instead (E-27).
- **`node:sqlite`.** [Fact] It is only a release candidate in Node 24 (E-08). Its availability in the extension host's embedded Node is not verified (A-04).
- **Workload.** Indexing large repositories is CPU-heavy. Running it in the extension host would compete with every other extension and could hurt editor responsiveness. [Assumption, standard VS Code guidance; measured in Phase 06.]
- **Agent clients.** CodeForge and MCP clients need CIE **without** VS Code.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. In-process inside the extension host (sql.js / `node:sqlite`, WASM tree-sitter) | No process management; simplest install | Blocks the extension host on large repos; `node:sqlite` not stable (E-08); unusable by agents without VS Code; sql.js keeps the DB in memory |
| B. Out-of-process runtime on system Node, stdio transport | Native `better-sqlite3`; isolation from the editor; the same runtime serves the CLI, extension and agents | Process lifecycle; requires system Node ≥ the selected LTS; packaging of native prebuilds |
| C. Shared long-lived daemon serving many clients | One index for the extension and agent simultaneously | Needs IPC discovery, locking and auth; premature |

## Decision

1. **The core is transport-agnostic.** `@cie/core` exposes application services and query use cases as plain async TypeScript functions that accept a shared-kernel `CancellationSignal`. That type is structurally satisfied by `AbortSignal`, so the core needs no Node or DOM types. It knows nothing about JSON-RPC, MCP, HTTP, processes or VS Code.
2. **MVP deployment = Option B.** `@cie/runtime` is a Node process, one per workspace, speaking JSON-RPC 2.0 over stdio. The extension spawns it on system Node, and CLI and agent clients spawn it the same way.
3. **In-process deployment is [DEF].** It is kept possible by these rules:
   - The storage, parser and filesystem ports are not tied to Node-only APIs in the core.
   - A future `InProcessHost` composition root can wire WASM or `node:sqlite` adapters.
   - Revisit trigger: `node:sqlite` stable **and** the extension-host Node supports it **and** a benchmark shows acceptable editor impact.
4. **Concurrent clients.** One writer process per workspace (SN-004). A second runtime started for the same workspace runs **read-only**: queries are served from SQLite WAL readers and index jobs are refused with `CIE_BUSY`. This lets CodeForge and VS Code coexist without a daemon (Option C is deferred).

## Consequences

- Positive:
  - Editor isolation and native performance.
  - One runtime for all consumers.
  - Agents need no VS Code.
- Negative:
  - Users need system Node. The extension must detect a missing or old Node and explain the fix.
  - Platform-specific packaging (A-05).
- Follow-ups:
  - Spike S1 (Phase 01): `better-sqlite3` loads on Node 24 and 26 on win32-x64 and linux-x64 (A-02).
  - Phase 06 measures extension activation and memory.

## Evidence

E-07, E-08, E-27.

## Revisit trigger

Revisit when `node:sqlite` is stable in an LTS that is also embedded in VS Code, or when user research shows that a system-Node requirement blocks adoption.
