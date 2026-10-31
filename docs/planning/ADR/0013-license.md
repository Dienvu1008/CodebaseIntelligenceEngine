# ADR-0013: License

- **Status:** **Open** (no decision; no LICENSE file is to be created until this ADR is Accepted)
- **Date:** 2026-10-31
- **Related:** DEC-11, NFR-070, NFR-071, OQ-01

## Context

- The stakeholder has not decided. CodeForge's license **does not** apply to CIE automatically.
- [Fact] The dependencies known so far are permissive:
  - MIT: web-tree-sitter, grammars, better-sqlite3, MCP SDK, ArchUnitTS (E-02..E-12).
  - Apache-2.0: scip-typescript (E-16), which is optional.
- Distribution channels under consideration: VS Code Marketplace / Open VSX for the extension, npm for `@cie/protocol` and `@cie/client`.

## Options

| Option | Pros | Cons |
|---|---|---|
| Apache-2.0 | Explicit patent grant; NOTICE mechanism; enterprise-friendly; compatible with all known dependencies | Longer text; NOTICE obligations |
| MIT | Simplest; maximal adoption; compatible with all known dependencies | No explicit patent grant |
| Proprietary / source-available | Commercial control | Restricts community contributions; the Marketplace allows it, but agent ecosystems prefer open protocols. A possible split: proprietary engine plus permissive `@cie/protocol`/`@cie/client`. |
| Dual / split licensing | Open protocol, protected engine | Contributor complexity (CLA) |

## Considerations to resolve

1. Will `@cie/protocol` and `@cie/client` be consumed by third-party agents? If yes, a permissive license for at least those packages is strongly advisable.
2. Are external contributions expected? If yes, a DCO or CLA is needed.
3. Is there a commercial intent for the engine or extension?

## Decision

**None.** Implementation can proceed through Phase 06 without this decision. It **must** be decided before:
- any public repository is published;
- any package is published to npm, the Marketplace or Open VSX.

Until then, package manifests use `"license": "UNLICENSED"` and `"private": true`. This is a placeholder that grants no rights.

## Revisit trigger

Before the first external distribution, or before accepting the first external contribution.
