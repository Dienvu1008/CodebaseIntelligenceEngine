# VS Code Extension Design (`cie-vscode`)

> Status: Baseline v0.1 · Related: ADR-0002, ADR-0003, ADR-0005, FR-080..085, SEC-006, E-11

## 1. Role

The extension is a **presentation adapter**. It owns no business logic, never opens a CIE store, and never parses code for indexing. It does four things:

1. Spawns and supervises the runtime (system Node, stdio JSON-RPC via `@cie/client`).
2. Translates VS Code events into runtime hints, and runtime results into VS Code UI.
3. Hosts the Webview and validates every message the Webview sends.
4. Performs symbol-accurate navigation.

## 2. Structure

```
packages/vscode-extension/
├── package.json             # contributes, activationEvents, engines.vscode (pinned in Phase 06)
├── src/host/                # extension host (esbuild → dist/extension.cjs, --external:vscode)
│   ├── extension.ts         # activate/deactivate; thin
│   ├── runtime-supervisor.ts# spawn, handshake, restart with backoff, version check
│   ├── views/               # WikiTreeProvider, ArchitectureTreeProvider, StatusBar
│   ├── commands/            # cie.search, cie.openPage, cie.reindex, cie.reveal, …
│   ├── navigation.ts        # anchor → editor reveal (§6)
│   ├── hover.ts             # HoverProvider: concept card summary for symbols under cursor
│   ├── webview-host.ts      # panel creation, CSP, message router (validation)
│   └── change-hints.ts      # FileSystemWatcher + onDidSave → workspace.notifyChanges
├── src/shared/messages.ts   # typed Webview protocol (shared by host + webview)
└── webview/                 # React + TS + Vite → dist/webview/{index.js,index.css}
    ├── src/App.tsx, routes/{Page,Search,Graph}.tsx
    ├── src/components/{BottomSheet,ConceptCard,StatusBadge,EvidenceList}.tsx
    └── src/markdown/        # markdown-it (html: false) + cie: link plugin + DOMPurify
```

Most host logic sits in pure modules (view models, message validation, navigation decisions) that are tested with Vitest without VS Code. `extension.ts` stays a thin edge, following the CodeForge pattern noted in E-27.

## 3. Evaluation of the VS Code building blocks

| Element | Use | Notes |
|---|---|---|
| Extension host | Supervisor, commands, views, navigation | No native modules; CPU work stays in the runtime |
| Webview (React + TS) | Wiki page rendering, search results, bottom sheet, relationship explorer, architecture graph (Phase 08) | Best fit for rich UI. Costs memory, so one panel is reused (§5). |
| TreeView | Wiki Explorer (pages by kind and folder), Architecture Explorer (components → members, violations) | Native, accessible and lightweight. Preferred for hierarchical browsing. |
| QuickPick | `cie.search`: symbols, concepts and pages with live results (debounced, cancellable) | Native, keyboard-first |
| HoverProvider | Short concept or claim info for the symbol under the cursor, with command links ("Open concept card") | Native, so no Webview is needed for quick info |
| Code navigation APIs | `vscode.executeDocumentSymbolProvider`, `window.showTextDocument`, `TextEditor.revealRange` | Live cross-check of anchors (§6) |
| FileSystemWatcher | **Hints only**, forwarded to the runtime. The runtime verifies by hash and reconciles periodically. | Watchers can drop events (R-07) |
| Workspace lifecycle | `onDidChangeWorkspaceFolders`: one runtime per folder (WS-003); stop runtimes for removed folders; untrusted workspaces → restricted mode (§8) | |
| Cancellation | QuickPick and command `CancellationToken` → `$/cancelRequest`; long jobs are cancellable from the status bar | FR-074 |
| Activation | `onView:cie.*`, `onCommand:cie.*`, `workspaceContains:.cie/workspace.json`; **not** `*` and **not** `onStartupFinished` by default | Keeps startup cost at zero for non-CIE workspaces |
| Packaging | esbuild host bundle + Vite webview bundle. The runtime is distributed as an npm package (MVP) or a bundled platform-specific VSIX (A-05, OQ-06). | §9 |

## 4. Webview message protocol

The protocol is typed, versioned and validated. The Webview can only *ask*; the host decides.

```ts
// src/shared/messages.ts (specification sketch)
export type WebviewToHost =
  | { v: 1; type: 'ready' }
  | { v: 1; type: 'query'; id: string; method: QueryMethod; params: unknown }   // allow-listed query-profile methods only
  | { v: 1; type: 'navigate'; target: { kind: 'anchor'; symbolId: string } | { kind: 'page'; pageId: string } }
  | { v: 1; type: 'cancel'; id: string }
  | { v: 1; type: 'resolveConflict'; pageId: string; sectionId: string; action: 'accept' | 'keep' | 'detach' } // control → requires user confirmation in host
  | { v: 1; type: 'persistState'; state: ViewState };

export type HostToWebview =
  | { v: 1; type: 'result'; id: string; ok: true; data: unknown }      // protocol DTOs only
  | { v: 1; type: 'result'; id: string; ok: false; error: { code: CieErrorCode; message: string } }
  | { v: 1; type: 'revision'; seq: number; freshness: 'current' | 'stale' | 'unknown' }
  | { v: 1; type: 'theme'; kind: 'light' | 'dark' | 'highContrast' };
```

Host-side rules (SEC-006):
- Messages are validated against a schema. Unknown types are dropped and logged.
- `query.method` must be in the query-profile allow-list (SEC-004).
- `navigate` accepts **IDs only**, never raw paths. The host resolves IDs through the runtime.
- `resolveConflict` shows a native confirmation dialog before calling the control method.

## 5. UI design

### 5.1 Surfaces

| Surface | Contents |
|---|---|
| Activity bar "CIE" container | **Wiki Explorer** (TreeView), **Architecture Explorer** (TreeView, Phase 08), **Problems-like list** (broken/stale links, conflicts) |
| Status bar item | `$(book) CIE: current r42` / `indexing 63%` / `stale (5 changes)` / `error`. Click: menu with reindex, cancel, show log. |
| Wiki panel (one reused WebviewPanel) | Rendered page, breadcrumbs, back/forward, a status legend, and the bottom sheet |
| QuickPick | Unified search |
| Editor hover | Concept and claim quick info |

### 5.2 Bottom-sheet concept card: evaluation

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Bottom sheet inside the Webview** (slides up over the lower part of the page when a concept or symbol link is activated) | Keeps reading context; shows rich content (status, evidence, relations, code snippet); one-click "Open full page" / "Go to code" | Custom component, so accessibility must be built carefully | **Chosen** for the Webview |
| Navigate to a new page on every click | Simple | Loses context; Wikipedia's own hover-preview shows users want previews | Supplementary ("Open full page") |
| Native editor hover | Native, accessible | Plain Markdown only; small; editor-only | **Chosen** for editor context |
| Peek view | Native inline | Not extensible with custom content | Rejected |
| Separate side panel | Persistent | Uses screen space; duplicates the panel | Rejected for the MVP |

**Bottom-sheet behavior and accessibility requirements:**
- Opens on link activation by click, Enter or Space. A hover preview after a delay is optional and off for keyboard-only users.
- Uses `role="dialog"`, `aria-modal="true"` and `aria-labelledby`. Focus moves to the sheet title and is trapped inside. `Esc` closes the sheet and returns focus to the originating link.
- Three snap heights (peek, half, full), with keyboard shortcuts. Honors `prefers-reduced-motion` (no slide animation).
- Shows: title, kind, status badge **with a text label**, and a 3–5 line summary (generated sections labeled as such). It also shows top relations, each with a status, and evidence entries with clickable anchors. Actions: "Go to code", "Open page", "Show in graph".
- Colors use VS Code theme CSS variables, and the sheet is tested in high-contrast themes (E-11).
- [Note] Full WCAG compliance needs manual testing with assistive technologies and an expert accessibility review. Phase 06 includes an audit task, but automated checks are not sufficient.

### 5.3 Webview lifecycle
- Webview state is kept minimal via `getState`/`setState`. `retainContextWhenHidden` is avoided, and a `WebviewPanelSerializer` restores panels (E-11).
- Every data access is a fresh query, pinned to the revision announced by the host.

## 6. Symbol-accurate source navigation

The goal is to reveal the **actual current symbol**, never a blindly stored line (FR-083).

```mermaid
sequenceDiagram
  autonumber
  participant WV as Webview (bottom sheet)
  participant H as Extension host
  participant R as Runtime
  participant VS as VS Code APIs
  WV->>H: navigate {anchor: symbolId}
  H->>R: symbols.resolveAnchor {symbolId}
  R-->>H: {state: resolved|redirected|deleted, symbolId', path, range, name, container, kind, seq}
  alt deleted
    H-->>WV: show "removed in r47" + suggestions (labeled)
  else resolved / redirected
    H->>VS: openTextDocument(path)
    H->>VS: executeDocumentSymbolProvider(uri)
    VS-->>H: live DocumentSymbol tree
    H->>H: match by (container chain + name + kind); prefer the one nearest range
    alt match found
      H->>VS: showTextDocument + revealRange(match.selectionRange)
    else no live match (no language support / dirty buffer diverged)
      H->>VS: reveal index range, show "location may be outdated" notification
    end
  end
```

- The live cross-check handles unsaved edits (DOCUMENTATION_MODEL §11, scenario F) and drift between index revisions.
- If the document is dirty and the index is stale, navigation uses the live match and offers "re-index now".

## 7. Runtime supervision

| Concern | Design |
|---|---|
| Node discovery | `cie.nodePath` setting, otherwise `node` on PATH. The runtime handshake reports `process.version`. Below the ADR-0004 minimum, the extension shows an actionable error. |
| Spawn | `node <runtime>/bin/cie.js serve --stdio --workspace <folder>`. The environment is minimal; secrets are not inherited beyond the OS defaults. |
| Health | `$/cie/heartbeat` notification. If it is missed N times, the runtime is restarted with exponential backoff, capped. After 3 crashes in 5 minutes the extension stops retrying and shows the log. |
| Logs | An OutputChannel `CIE`. The runtime's stderr is captured. Secrets are redacted by the runtime log formatter. |
| Shutdown | `shutdown` request on deactivate or folder removal, then kill after a timeout. |
| Followers | If another writer holds the lease (for example a CodeForge-spawned runtime), the extension's runtime runs as a read-only follower and the status bar shows "read-only". |

## 8. Security

- CSP: `default-src 'none'; img-src ${cspSource} data:; style-src ${cspSource}; script-src 'nonce-<random>'; font-src ${cspSource}`. No inline scripts and no remote content (E-11).
- `localResourceRoots`: `[extensionUri/dist/webview]` only. The Webview never reads workspace files directly.
- Markdown rendering uses `markdown-it` with `html: false`, `linkify: false` and a custom `cie:` link renderer, and DOMPurify runs on the output. Repo content is untrusted (NFR-030).
- External links (`http(s)`) open through `vscode.env.openExternal` after a confirmation.
- **Workspace Trust.** In untrusted workspaces the extension runs in restricted mode. It can read an existing index read-only and serve queries, but it does not start indexing and does not run enrichers ([Proposal]; `capabilities.untrustedWorkspaces: { supported: 'limited' }`).

## 9. Packaging and cross-platform

| Option | Pros | Cons | Status |
|---|---|---|---|
| A. Extension plus runtime installed separately (`npm i -g @cie/runtime`, pinned version check) | Small VSIX; one native build matrix (npm prebuilds, E-07) | Extra install step | **MVP default** |
| B. Platform-specific VSIX bundling the runtime and the native `better-sqlite3` binary | One-click install | Build matrix per target (A-05) | Phase 06 stretch / post-MVP (OQ-06) |

- CI builds and tests the extension on `windows-latest` and `ubuntu-latest`. macOS is not a CI target in the MVP ([DEF]; Assumption: it works through the same Node and prebuild path).
- Path handling: the runtime returns canonical `/` paths. The host converts them with `vscode.Uri.joinPath(folderUri, ...segments)` and never by string concatenation.
