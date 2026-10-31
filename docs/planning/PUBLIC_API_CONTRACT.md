# Public API Contract (`@cie/protocol` v1)

> Status: Baseline v0.1 (pre-1.0 until Phase 09; frozen as v1.0 at the Phase 09 exit) · Related: ADR-0003, SN-006, SEC-004, API-001..003, FR-070..079

## 1. Design decision: segregated contracts versus a unified interface

The brief proposes one `KnowledgeProvider` interface.

| Option | Pros | Cons |
|---|---|---|
| One unified `KnowledgeProvider` interface | One import; simple mocks | Every consumer depends on every method; it grows into a god interface; versioning is all-or-nothing |
| **Segregated read-only query ports** (`SymbolQueries`, `ReferenceQueries`, `DependencyQueries`, `ConceptQueries`, `ArchitectureQueries`, `ImpactQueries`, `FlowQueries`, `WikiQueries`, `EvidenceQueries`, `WorkspaceQueries`), served through **one versioned JSON-RPC namespace** | Interface segregation; capabilities can be advertised per port (e.g. `flows` unavailable); consumers mock only what they use; ports version independently as minor additions | Slightly more types |

**Decision ([Proposal]):** use segregated ports in `@cie/protocol` and on the core's query side. `@cie/client` composes them into a convenience `CieClient` facade, so consumers who want a single object still get one. The facade only aggregates the ports and adds no behavior.

Two other corrections to the brief's sketch:
- `getSymbol(id): Promise<SymbolResult>` cannot express "not found", "stale" or "revision". Every method returns an **envelope** (§4).
- `searchSymbols(): Promise<SymbolResult[]>` has no bounds. Every list result is paginated (API-002).

## 2. Profiles

| Profile | Methods | Who | Transport |
|---|---|---|---|
| **query** | All `*.search`, `*.get`, `*.list`, traversal, `workspace.status`, `wiki.getPage`, `wiki.validate` (report only) | Everyone: extension, CLI, agents, MCP | JSON-RPC, MCP |
| **control** | `index.run`, `index.cancel`, `workspace.notifyChanges`, `docs.generate`, `docs.publish`, `docs.resolveConflict`, `shutdown` | Local trusted clients (extension, CLI). Off for MCP. Optional for agent clients via `initialize.capabilities.control: true` [Proposal]. | JSON-RPC only |

The query profile never writes to source, wiki or stores (SEC-004). Control methods write only CIE-owned stores and, through `docs.*`, `wiki.dir` under the DOC-* guards. **No method executes code or modifies source files.**

## 3. Session and versioning

```jsonc
// → request
{ "jsonrpc": "2.0", "id": 1, "method": "cie.initialize", "params": {
    "client": { "name": "codeforge-cie-adapter", "version": "0.1.0" },
    "apiVersions": ["1"],                     // client-supported majors
    "workspaceRoot": "/abs/path/to/repo",     // must match the runtime's bound root (WS-003)
    "capabilities": { "control": false, "notifications": ["revisionPublished", "progress"] } } }
// ← result
{ "jsonrpc": "2.0", "id": 1, "result": {
    "apiVersion": "1.3",                      // negotiated: highest common major, server minor
    "server": { "name": "cie", "version": "0.6.0", "node": "v24.x" },
    "workspaceId": "ws_01J…",
    "mode": "writer",                         // or "follower"
    "ports": {                                // capability advertisement (per port, per language)
      "symbols": true, "references": true, "dependencies": true, "concepts": true,
      "architecture": false, "impact": true, "flows": false, "wiki": true, "evidence": true },
    "languages": [
      { "id": "ts", "fidelity": { "symbols": "L3", "imports": "L3", "references": "L3", "calls": "L3", "typeRelations": "L3", "di": "L2" } },
      { "id": "py", "fidelity": { "symbols": "L1", "imports": "L2", "references": "L2", "calls": "L2", "typeRelations": "L2", "di": "L0" } } ],
    "limits": { "maxLimit": 500, "defaultLimit": 50, "maxDepth": 6, "defaultDeadlineMs": 5000 } } }
```

**Versioning rules (API-001):**
- Major versions are explicit (`v1`). A breaking change requires `v2`. A server may support several majors at once.
- Minor versions are additive only: new optional fields, new methods, new enum values. Clients **must ignore unknown fields** and **must tolerate unknown enum values**, treating them as `unknown`.
- DTO stability: fields are never repurposed. Deprecations are announced in `initialize.result.deprecations[]` for at least one minor release before removal in the next major.
- The default limits in the example above (500, 50, 6, 5000 ms) are [Proposal] API safety caps. They are configurable and are not performance targets.

## 4. Response envelope

```ts
// @cie/protocol/v1/envelope.ts (specification)
export interface RevisionInfo {
  seq: number;
  freshness: 'current' | 'stale' | 'unknown';   // SN-001
  pendingChanges?: number;
  publishedAt: string;                          // ISO-8601
}
export interface PageInfo { nextCursor?: string; truncated: boolean; limit: number; }
export interface Envelope<T> {
  apiVersion: string;
  workspaceId: string;
  revision: RevisionInfo;                       // SN-006
  data: T;
  page?: PageInfo;                              // present for list results (API-002)
  fidelity?: Partial<Record<Capability, Fidelity>>; // fidelity of the data returned
  warnings?: Array<{ code: string; message: string }>; // e.g. PARTIAL_RESULTS, LANGUAGE_FIDELITY_LIMITED
}
```

**Cursors** are opaque base64url strings that encode `{seq, sortKey, filtersHash}`. A cursor used after its `seq` has been garbage-collected returns `CIE_REVISION_UNAVAILABLE`. Results are never silently mixed across revisions.

**Revision pinning.** Any query may pass `atSeq`. If omitted, the server uses head at request start.

## 5. Common DTOs (abridged)

```ts
export interface SourceRange { startLine: number; startCol: number; endLine: number; endCol: number } // 0-based, UTF-16, end-exclusive
export interface Location { path: string; range: SourceRange }          // workspace-relative canonical path
export interface Anchor { symbolId: string; location: Location; spanHash: string; seq: number }

export type ClaimStatus = 'verified' | 'inferred' | 'user_asserted' | 'unknown';
export interface EvidenceDTO {
  id: string; kind: 'filesystem'|'ast'|'compiler'|'scip'|'lsp'|'heuristic'|'llm'|'user';
  producer: string; seq: number; contentHash: string;
  location?: Location; artifact?: string;                                // PV-003
}
export interface SymbolDTO {
  id: string; name: string; qualifiedName: string; kind: SymbolKind; language: string;
  location: Location; exported: boolean; spanHash: string;
  container?: string; doc?: string; fidelity: Fidelity;
}
export interface RelationDTO {
  type: string; from: string; to: string;
  status: ClaimStatus; freshness: 'current'|'stale'; precision?: 'exact'|'heuristic';
  evidence?: EvidenceDTO[];                                              // included when evidence: 'inline'
  evidenceCount: number;
}
```

**Evidence delivery.** Every method accepts `evidence: 'none' | 'count' | 'inline'` (default `count`). `evidence.get {ids}` fetches evidence on demand, so payloads stay small for agents.

## 6. Method catalog (v1)

| Port | Method | Params (key) | Returns `data` | Phase |
|---|---|---|---|---|
| Workspace | `workspace.status` | — | `{head, freshness, jobs[], languages[], counts}` | 06 |
| Symbols | `symbols.search` | `query, kinds?, languages?, pathGlob?, exportedOnly?, limit, cursor?` | `SymbolHit[]` (`SymbolDTO` + score) | 06 |
| Symbols | `symbols.get` | `id` or `ids[]` | `SymbolDTO \| null` (missing → `null` + warning; lineage → `redirectedFrom`) | 06 |
| Symbols | `symbols.resolveAnchor` | `symbolId \| anchor` | `{state: resolved\|redirected\|drifted\|deleted, symbol?, lineage[]}` | 06 |
| Symbols | `symbols.outline` | `path` | `SymbolDTO[]` tree | 06 |
| References | `references.list` | `symbolId, kinds?: ['references','calls'], limit, cursor` | `ReferenceDTO[]` (site location + from symbol + status) | 06 |
| Dependencies | `dependencies.query` | `subject: {file\|symbol}, direction: out\|in, types?, maxDepth, limit` | `{nodes[], edges: RelationDTO[]}` | 06 |
| Graph | `graph.neighbors` | `id, direction, types?, perTypeLimit` | grouped `RelationDTO[]` | 06 |
| Concepts | `concepts.search` | `query, limit` | `ConceptHit[]` | 06 |
| Concepts | `concepts.get` | `id` | `{concept, pages[], implementations: RelationDTO[], related: RelationDTO[]}` | 06 |
| Architecture | `architecture.get` | `level: component\|package, includeViolations?` | `{components[], dependsOn: RelationDTO[], violations[]}` | 08 |
| Impact | `impact.affectedSymbols` | `changed: {paths?, symbolIds?}, maxDepth, limit, types?` | `ImpactItem[]` (`symbol, depth, path[], weakestStatus`) | 06 |
| Flows | `flows.trace` | `entry: symbolId, maxDepth, limit, includeDispatch?` | `{steps[], edges[], summary: {verifiedSteps, inferredSteps, unresolvedCalls}, completeness}` | 08 |
| Wiki | `wiki.listPages` | `kind?, limit, cursor` | `PageSummary[]` | 06 |
| Wiki | `wiki.getPage` | `pageId, render?: 'markdown'\|'ast'` | `{page, markdown, sections[], links[] (with states)}` | 06 |
| Wiki | `wiki.validate` | `scope?` | `{broken[], stale[], conflicts[], malformed[]}` | 06 |
| Evidence | `evidence.get` | `ids[]` | `EvidenceDTO[]` | 06 |
| *control* | `index.run` | `mode: full\|incremental, paths?` | `{jobId}` + progress notifications | 06 |
| *control* | `index.cancel` | `jobId` | `{cancelled}` | 06 |
| *control* | `workspace.notifyChanges` | `events[]` (hints) | `{accepted}` | 06 |
| *control* | `docs.generate` | `pageId \| scope, generator: template\|llm` | `{written[], conflicts[], skipped[]}` | 06 (template) / 07 (llm) |
| *control* | `docs.publish` | `pageIds[]` | `{published[], conflicts[]}` | 06 |
| *control* | `docs.resolveConflict` | `pageId, sectionId, action` | `{ok}` | 06 |

**Notifications from the server:** `$/cie/revisionPublished {seq}`, `$/cie/progress {jobId, phase, done, total}`, `$/cie/heartbeat`.

**Mapping of the brief's sketch:**

| Brief method | Maps to |
|---|---|
| `searchSymbols` | `symbols.search` |
| `searchConcepts` | `concepts.search` |
| `getSymbol` | `symbols.get` |
| `getDependencies` | `dependencies.query` |
| `getReferences` | `references.list` |
| `getArchitecture` | `architecture.get` |
| `getAffectedSymbols` | `impact.affectedSymbols` |

## 7. Errors (API-003)

JSON-RPC `error.code` uses the server-error range `-32000..-32099` with a stable string in `error.data.cieCode`:

| `cieCode` | JSON-RPC code | Meaning | Retry? |
|---|---|---|---|
| `CIE_INVALID_PARAMS` | -32602 | Schema validation failed | no |
| `CIE_UNSUPPORTED_VERSION` | -32001 | No common API major | no |
| `CIE_WORKSPACE_MISMATCH` | -32002 | Request is for a different workspace (WS-003) | no |
| `CIE_INDEX_NOT_READY` | -32003 | No published revision yet | yes, after `revisionPublished` |
| `CIE_REVISION_UNAVAILABLE` | -32004 | Pinned seq was garbage-collected | restart the query without a cursor |
| `CIE_NOT_FOUND` | -32005 | Unknown ID (only where `null` is not meaningful) | no |
| `CIE_CAPABILITY_UNAVAILABLE` | -32006 | Port or language capability not supported (e.g. flows for Python at L0) | no |
| `CIE_DEADLINE_EXCEEDED` | -32007 | `_meta.deadlineMs` elapsed. Partial results are never returned as success. | yes, with a larger deadline or limit |
| `CIE_CANCELLED` | -32800 | Cancelled via `$/cancelRequest` (LSP convention) | — |
| `CIE_BUSY` | -32008 | Control method refused because another writer holds the lease | yes |
| `CIE_FORBIDDEN_PROFILE` | -32009 | Control method on a query-only session | no |
| `CIE_PUBLISH_CONFLICT` | -32010 | Internal CAS failure surfaced on `index.run` (SN-002) | yes |
| `CIE_INTERNAL` | -32603 | Bug. The message is sanitized (no stack traces, no absolute paths outside the workspace). | maybe |

## 8. Timeouts and cancellation

- Every request may carry `params._meta.deadlineMs`. The server default comes from `limits.defaultDeadlineMs`. The runtime creates an `AbortSignal`, and every core use case and adapter call honors it.
- `$/cancelRequest {id}` aborts the same signal.
- Index jobs are long-running and are not tied to a request deadline. They are cancelled with `index.cancel`.

## 9. Workspace isolation and index revision consistency

- One runtime equals one workspace. `workspaceRoot` in `initialize` must match, and `workspaceId` is echoed in every envelope (WS-003).
- All results within one response come from a single seq. A paginated sequence stays on its cursor's seq (API-002).

## 10. MCP mapping (Phase 09, `@cie/mcp`)

- [Fact] MCP `2026-07-28` uses per-request protocol versions plus `server/discover` (E-09), and the TS SDK is at 1.32.2 (E-10). The SDK version is pinned at Phase 09 entry.
- The MCP server wraps the same `ProtocolHandler`. **Query profile only** (SEC-004).

| MCP tool (read-only) | Wraps | Notes |
|---|---|---|
| `cie_search_symbols` | `symbols.search` | Results are summarized as text plus structured content; IDs are always included |
| `cie_get_symbol` | `symbols.get` + `symbols.resolveAnchor` | |
| `cie_find_references` | `references.list` | |
| `cie_get_dependencies` | `dependencies.query` | `maxDepth` capped lower for MCP by default ([Proposal]: 3) |
| `cie_affected_symbols` | `impact.affectedSymbols` | |
| `cie_trace_flow` | `flows.trace` | Includes `completeness` |
| `cie_search_concepts` / `cie_get_concept` | `concepts.*` | |
| `cie_get_architecture` | `architecture.get` | |
| `cie_get_wiki_page` | `wiki.getPage` | Content is returned **as untrusted data**, with a provenance header |

| MCP resource | URI template |
|---|---|
| Wiki page | `cie://wiki/{pageId}` |
| Symbol card | `cie://symbol/{symbolId}` |
| Workspace status | `cie://status` |

All tools carry `readOnlyHint: true` and describe their outputs as **advisory, untrusted repository-derived content**. MCP prompts are not offered.

## 11. Contract tests

`tests/contracts/` runs one table-driven suite over these transports:
1. in-process `ProtocolHandler`;
2. JSON-RPC stdio;
3. MCP stdio (Phase 09).

The suite covers schemas, envelopes, errors, pagination stability, deadline and cancellation behavior, and profile enforcement (FF-BND-004). Snapshot files of `@cie/protocol` declarations are committed (FF-BND-006).
