# ADR-0004: Node.js LTS Selection

- **Status:** Accepted. Spike S1 confirmed it (E-33): `better-sqlite3` works on Node 24 and 26 on win32-x64 and linux-x64. Node 24 stays the reference Node for benchmarks until the Phase 05 baselines exist, and Node 26 is fully supported.
- **Date:** 2026-10-31
- **Related:** DEC-09, NFR-053, ADR-0002

## Context

- [Fact] Node 20 has been EOL since 2026-03-24. Node 22, 24 and 26 are LTS, and Node 27 is Alpha (E-01).
- [Fact] CodeForge declares `node >=20` (E-20). CIE must **not** inherit that.
- [Fact] Key dependency constraints:

| Dependency | Constraint | Evidence |
|---|---|---|
| `better-sqlite3` 13.0.3 | Node ≥22 | E-07 |
| `@sourcegraph/scip-typescript` 0.6.0 | Node ≥22.23.4 (optional enricher) | E-16 |
| `web-tree-sitter` 0.27.1, `better-sqlite3` and the MCP SDK | Published from Node 24 builds | E-02, E-07, E-10 |

- [Assumption] On the usual even-release schedule, Node 26 entered Active LTS in October 2026 and Node 24 is in Maintenance LTS. E-01 lists both only as "LTS", so the Active/Maintenance split is not verified. Node 22 is the oldest supported line and will reach EOL first.
- **The runtime runs on system Node (ADR-0002), so it does not depend on VS Code's embedded Node (A-04).** Extension-host code is a separate bundle targeting VS Code's engine.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Node 22 | Widest install base | Nearest EOL; would immediately need a migration |
| **Node 24** | Mature; the dependency ecosystem builds on it (E-02, E-07, E-10) | Likely already in Maintenance LTS [Assumption] |
| **Node 26** | Current Active LTS [Assumption]; longest runway | Newest; native prebuild coverage not yet verified (A-02) |

## Decision

| Setting | Value |
|---|---|
| `engines.node` | `>=24 <27` |
| CI matrix | Node 24 and Node 26, on `windows-latest` and `ubuntu-latest` |
| Reference Node for benchmarks and development | **Node 24** until spike S1 confirms `better-sqlite3` and `web-tree-sitter` on Node 26 for both OSes; then Node 26 becomes the reference |
| Extension host bundle | esbuild target pinned to the Node version embedded in the minimum supported VS Code (determined in Phase 06, A-04) |

## Consequences

- Users must have Node ≥24 on PATH, or set `cie.nodePath`. The extension checks the version via the runtime handshake.
- Phase 00 CI proves the toolchain on both Node versions.

## Evidence

E-01, E-02, E-07, E-10, E-16, E-20.

## Revisit trigger

- Node 24 reaches EOL.
- Node 28 reaches LTS.
- A required dependency drops Node 24.
