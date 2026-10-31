# ADR-0003: JSON-RPC 2.0 over stdio for the MVP; MCP Adapter from Phase 09; HTTP Deferred

- **Status:** Accepted
- **Date:** 2026-10-31
- **Related:** DEC-06, FR-070..079, [PUBLIC_API_CONTRACT](../PUBLIC_API_CONTRACT.md)

## Context

- **Extension transport.** The VS Code extension spawns the runtime (ADR-0002), so stdio is the natural channel. No port is opened, and the OS ties the channel's lifetime to the child process.
- **Precedent.** LSP uses JSON-RPC over stdio, with `$/cancelRequest` for cancellation. VS Code developers know this model well. [Fact: CodeForge's LSP adapter uses JSON-RPC over stdio (E-23 context), and LSP itself is an industry standard.]
- **MCP state.** [Fact] MCP's current protocol version is 2026-07-28. The version is now declared per request, and older handshake-based revisions have a compatibility path (E-09). The TS SDK is at 1.32.2 and requires `zod` (E-10). Because MCP is evolving quickly, it should sit behind a thin adapter and be pinned late (Phase 09).
- **HTTP.** [Fact] CodeForge uses local HTTP for its observability server (E-27). That exposes a port, which then needs auth and CSRF protection.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. JSON-RPC stdio now, MCP in Phase 09, HTTP deferred | No ports; simple security; MCP stdio transport is a natural sibling | Clients must spawn the process; no browser clients |
| B. Local HTTP + token | Multiple clients share a daemon; easy curl debugging | Port exposure, token management, DNS-rebinding/CSRF risks |
| C. MCP as the only protocol | One protocol for agents | MCP churn (E-09); MCP's tool model does not fit typed extension UI calls (pagination, revision pinning) |

## Decision

**Option A.**

- `@cie/protocol` defines the method catalog and DTOs.
- `@cie/runtime` exposes a `ProtocolHandler` (protocol request → protocol response) and is wrapped by:
  - **the JSON-RPC stdio server** (Phase 06; framing is newline-delimited JSON or LSP-style `Content-Length` headers, chosen in Phase 06 as [Open] OQ-07)
  - **the MCP server** (`@cie/mcp`, Phase 09), which maps query methods to read-only MCP tools and resources
- Both wrappers are thin and contain no query logic. Contract tests (FF-BND-004) run the same suite through both.
- HTTP is **[DEF]**. Revisit trigger: a concrete multi-client or browser need.

## Consequences

- Positive:
  - Minimal attack surface.
  - One query implementation.
  - MCP risk is isolated in one package.
- Negative: no shared daemon. Concurrent clients run separate processes, with read-only followers per ADR-0002.

## Evidence

E-09, E-10, E-27.
