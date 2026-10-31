# ADR-0014: Symbol Identity and Lineage

- **Status:** Accepted
- **Date:** 2026-10-31
- **Related:** SY-001..005, [DOMAIN_MODEL §4](../DOMAIN_MODEL.md), [DOCUMENTATION_MODEL §6](../DOCUMENTATION_MODEL.md)

## Context

Wiki links, claims, evidence and agent queries all reference symbols. Identity has to be:

- **deterministic** across runs and machines;
- **human-debuggable**;
- **stable under edits that do not change what the symbol is**, such as body edits or moving the symbol within its file.

Renames and moves are real identity changes, and they must be **explicit** (brief §4).

## Options considered

| Option | Stability | Problems |
|---|---|---|
| Random UUID per symbol, persisted | Stable only if matching works perfectly | Non-deterministic; a rebuild from scratch changes every ID, which violates NFR-020/023 |
| Location-based (`path:line:col`) | Breaks on any edit above the symbol | Unacceptable |
| Content hash of the body | Breaks on any body edit | Unacceptable |
| **Structural path: language + module path + qualified name + kind + disambiguator** | Stable under body edits and in-file moves | Changes on rename or file move, handled by lineage |

## Decision

```
SymbolId := "<lang>:<modulePath>#<qualifiedName>(<kind>)[~<n>]"
  lang          ts | js | py | …       (adapter language id)
  modulePath    canonical workspace-relative path without extension normalization
                (e.g. src/auth/session.ts)
  qualifiedName dot-joined lexical container chain, e.g. SessionStore.refresh
                anonymous/default exports: "default"; unnamed → "<anon@ordinal>"
  kind          class | function | method | interface | type | enum | variable | property | module | …
  ~n            disambiguator, present only when (modulePath, qualifiedName, kind) collides:
                n = 1-based declaration order among the colliding set (overloads, redeclarations)
```

Example: `ts:src/auth/session.ts#SessionStore.refresh(method)`.

- **Storage key.** The full string is stored. A 64-bit hash (`xxh64` or the first 8 bytes of SHA-256) is used only as an internal index key, and collisions are checked.
- **Lineage.** On each revision, `SymbolMatcher` classifies every symbol of the previous revision as `unchanged | modified | moved | renamed | deleted`. This is SY-004, and the algorithm is in KNOWLEDGE_GRAPH_DESIGN §7.
  - The match uses `bodyFingerprint`, a hash of the normalized token stream excluding the symbol's own name, together with the container and the kind.
  - A rename or move produces a new ID and a `lineage(old → new, reason)` record.
- **Anchors and links.** Anchors and links that point at an old ID resolve through lineage. They are reported as `redirected` (stale-but-resolved) and are never broken silently.

## Phase 02 implementation notes

Implemented in `packages/core/src/code-intelligence/domain/` (P02-03). These points make the format above precise; they do not change it.

- **Kinds (closed set):** `module`, `namespace`, `class`, `interface`, `type`, `enum`, `enum_member`, `function`, `method`, `constructor`, `getter`, `setter`, `property`, `variable`, `constant`. Adding a kind is a format change and needs golden updates.
- **Name segments** must not be empty and must not contain `.`, `#`, `(`, `)`, `~`, whitespace, control characters or lone surrogates. A segment may start with `<` only as an `<anon@n>` placeholder. With these rules every id parses back into exactly its parts (`parseSymbolId`), and a module path may itself contain `#` (the parser splits at the last `#`). Names are not Unicode-normalized: JavaScript and Python treat differently normalized identifiers as distinct, so normalizing could merge two real symbols. Computed or otherwise unrepresentable names are the adapter's job to map onto a placeholder.
- **Disambiguator:** when a `(qualifiedName, kind)` pair occurs more than once in a module, *every* member of the colliding set gets `~n`, with n counted in declaration order. Adapters must pass declarations in source order; the FileExtraction factory rejects out-of-order drafts (`EXTRACTION_ORDER`), so the order cannot drift silently.
- **Containers** are given as a parent index into the same draft list, not as a name chain. The factory builds the qualified name from the parent chain and checks that each child range lies inside its parent's.
- **Construction:** only `identifySymbols` (SymbolIdentity) and `parseSymbolId` produce a `SymbolId`. A raw string is not assignable to the type (SY-001, type-level test).
- **Attribution (C-12):** each symbol carries `ProducerRef {adapterId, adapterVersion, toolVersion, fidelity}` with the profile's `symbols` fidelity.
- **Unresolved placeholders:** `unres:<lang>:<path>#<siteHash>`, where `siteHash` is the first 16 hex digits of `sha256(edgeType \n range \n rawSpecifier \n boundName)`. Each unresolved site gets its own node, and the same site always maps to the same node.

## Consequences

- Rebuilding from scratch reproduces identical IDs (NFR-023).
- Reordering colliding overloads can swap their `~n`. This is accepted: it is rare, and it shows up through spanHash mismatch detection.
- Identity is workspace-relative. Workspace scoping is physical (one DB per workspace; see WS-003).
