# Domain Invariants

> Status: Baseline v0.1 · Machine-readable mirror: [/governance/invariants.yaml](../../governance/invariants.yaml), validated by [/governance/invariants.schema.json](../../governance/invariants.schema.json). The two files must correspond 1:1, which FF-DAT-007 checks.

## 1. Format and rules

Each invariant has the following fields.

| Field | Meaning |
|---|---|
| **ID** | `^[A-Z]{2,3}-[0-9]{3}$`. Never reused. |
| **Owner** | The bounded context that owns the rule. |
| **Definition** | A precise, testable condition. |
| **Enforcement** | Where the rule is enforced. Values: `domain:` in-memory aggregate or service, `db:` schema constraint, `validator:` RevisionValidator before publish, `type:` compile-time, `adapter:` boundary guard, `ci:` static check. |
| **Violation class** | `REJECT` (operation refused with an error), `ABORT_PUBLISH` (revision abandoned), `DOWNGRADE` (status or freshness lowered), `CONFLICT` (recorded, no write), `QUARANTINE` (store isolated and rebuilt), `CI_FAIL`. |
| **Test** | The test path that Phase 00/01+ will create. |
| **Kind** | **Hard**: must always hold, and a violation is a bug. **Recommendation**: a quality target that is reported, not blocking. |
| **Severity** | CRITICAL, HIGH or MEDIUM. |
| **Phase** | The phase whose exit gate requires the test. |

**Phase gate rule ([HR], NFR-041).** Phase N cannot exit while any `ACTIVE` CRITICAL invariant with `phase ≤ N` lacks a passing test. HIGH invariants with `phase ≤ N` must also pass. MEDIUM and Recommendation items are reported.

**What is *not* an invariant.** The following are coding conventions, enforced by lint or review rather than by this register:
- naming;
- file layout;
- "use `Result` instead of throw" in the domain;
- import ordering;
- comment style;
- test naming.

Architecture rules are **fitness functions** (FF-*), not domain invariants (see [ARCHITECTURE_FITNESS](ARCHITECTURE_FITNESS.md)).

---

## 2. Workspace invariants (owner: workspace)

### WS-001: Source references belong to the workspace revision
- **Definition:**
  - (a) Every **structural** revision-scoped record that carries a source path (symbol node, reference, structural edge's intrinsic evidence) references a `CanonicalPath` that has a `FileRecord` version **visible at the same revision seq**.
  - (b) Every **explicit evidence** locator and every anchor references a `CanonicalPath` known to the workspace (`file_key` exists), together with the `contentHash` of the file version it was observed in. Historical versions are allowed; their freshness is decided by PV-004 and SN-008. This exception was resolved in the contradiction log, C-03.
- **Enforcement:** `db:` FK `node.file_key → file_key.key`, `evidence.file_key → file_key.key`; `validator:` interval-aware visibility check for (a).
- **Violation:** ABORT_PUBLISH · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01
- **Test:** `tests/invariants/ws/ws-001.spec.ts`. Constructs a staging revision with an orphan path and expects the publish to be refused.

### WS-002: Paths are canonical and confined to the root
- **Definition:** Every stored or accepted path `p` satisfies all of the following:
  - (a) `p` equals `canonicalize(p)`: relative, `/`-separated, NFC, with no `.`, `..` or empty segments, no leading `/`, and no drive or UNC prefix.
  - (b) `realpath(root/p)` has `realpath(root)` as a path prefix.
  - (c) A symlink whose target escapes the root is excluded and recorded as `skipped: symlink_escape`.
- **Enforcement:** `domain:` PathCanonicalizer; `adapter:` FileSystem guard applied to every read and write.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01
- **Test:** `tests/invariants/ws/ws-002.spec.ts`. Includes adversarial vectors: `..\\`, `C:\\`, `\\\\?\\`, mixed separators, Unicode look-alikes and symlink escapes, on Windows and Linux.

### WS-003: Workspace isolation
- **Definition:**
  - (a) A runtime instance is bound to exactly one `WorkspaceId`.
  - (b) On open, `index.db` and `state.db` contain a `meta.workspace_id` equal to the bound ID. Otherwise the stores are refused and the user is offered a rebuild.
  - (c) Every request carrying a `workspaceId` different from the bound one is rejected with `CIE_WORKSPACE_MISMATCH`.
- **Enforcement:** `adapter:` store open check; `domain:` request guard in the runtime handler.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01. Part (c) is also covered by a Phase 06 contract test.
- **Test:** `tests/invariants/ws/ws-003.spec.ts`

### WS-004: Deterministic enumeration
- **Definition:** For an identical file tree and identical configuration, the enumerated manifest (order and content) and its `manifestHash` are byte-identical across runs, operating systems and locales. Sorting uses UTF-16 code units, not locale collation.
- **Enforcement:** `domain:` IgnoreEvaluator + sorted manifest builder.
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** HIGH · **Phase:** 01
- **Test:** `tests/invariants/ws/ws-004.spec.ts` plus cross-platform golden vectors.

## 3. Symbol invariants (owner: code-intelligence)

### SY-001: Deterministic identity
- **Definition:** `SymbolId` is a pure function of `(language, modulePath, qualifiedName, kind, disambiguator)` per ADR-0014. Re-extracting identical content with an identical producer version yields identical IDs.
- **Enforcement:** `domain:` SymbolIdentity; `type:` the `SymbolId` constructor is private to SymbolIdentity.
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 02
- **Test:** `tests/invariants/sy/sy-001.spec.ts`. Uses property-based tests plus golden fixtures.

### SY-002: Uniqueness within a revision
- **Definition:** At any revision seq, no two visible symbol records share a `SymbolId`.
- **Enforcement:** `db:` partial unique index on `(symbol_id) WHERE valid_to_seq IS NULL` for the head, plus a `validator:` duplicate check over the staging set.
- **Violation:** ABORT_PUBLISH · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 02
- **Test:** `tests/invariants/sy/sy-002.spec.ts`

### SY-003: Verifiable location
- **Definition:** For each visible symbol `s` at seq `S`:
  - (a) `s.range` lies within the bounds of the file content whose hash is `file.hash` at `S`.
  - (b) `s.spanHash = sha256(utf8(text(file, s.range)))`, where `text` is the file content decoded per CODE_INTELLIGENCE_STRATEGY §6.1. Hashing the UTF-8 encoding of decoded text keeps the value platform- and encoding-independent (contradiction log C-04).
- **Enforcement:** The extractor computes spanHash from the same buffer it parsed. `validator:` checks bounds for all records and recomputes the hash for a deterministic sample at runtime (sample size is configurable), and for all records in tests.
- **Violation:** ABORT_PUBLISH · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 02
- **Test:** `tests/invariants/sy/sy-003.spec.ts`

### SY-004: Explicit lineage
- **Definition:** When revision `N` is published with base `N-1`, every symbol visible at `N-1` is classified exactly once as `unchanged | modified | moved | renamed | deleted`. Every `moved` or `renamed` symbol has a lineage record `(from, to, kind, N)`. No symbol disappears without a `deleted` classification.
- **Enforcement:** `domain:` SymbolMatcher; `validator:` count check (|old| = Σ classes).
- **Violation:** ABORT_PUBLISH · **Kind:** Hard · **Severity:** HIGH · **Phase:** 05
- **Test:** `tests/invariants/sy/sy-004.spec.ts`. Scripted edit, rename, move and delete fixtures.

### SY-005: Producer attribution
- **Definition:** Every symbol, reference and structural edge records a `ProducerRef {adapterId, adapterVersion, toolVersion, fidelity}`.
- **Enforcement:** `db:` NOT NULL columns; `type:` FileExtraction requires a producer.
- **Violation:** ABORT_PUBLISH · **Kind:** Hard · **Severity:** HIGH · **Phase:** 02
- **Test:** `tests/invariants/sy/sy-005.spec.ts`

### SY-006: Precision is not overstated
- **Definition:** An edge is recorded with `precision = exact` only if the producer's declared fidelity for that edge type is `L3`. Constructs the producer cannot resolve are recorded as edges to an `unresolved` placeholder node (with the raw specifier), never to a guessed target.
- **Enforcement:** `domain:` FileExtraction factory checks against the CapabilityProfile; `validator:`.
- **Violation:** ABORT_PUBLISH · **Kind:** Hard · **Severity:** HIGH · **Phase:** 02
- **Test:** `tests/invariants/sy/sy-006.spec.ts`. Covers dynamic `import(expr)`, `require(variable)`, Python `importlib`.

## 4. Knowledge graph invariants (owner: knowledge)

### KG-001: No dangling relations
- **Definition:** For every relation or edge visible at seq `S`, both endpoint nodes are visible at `S`. Removing a node in revision `N` closes (`valid_to_seq = N`) all incident relations in the same staging transaction.
- **Enforcement:** `db:` FK on stable `node_key`s (identity exists); `validator:` interval-aware endpoint visibility check.
- **Violation:** ABORT_PUBLISH · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 02
- **Test:** `tests/invariants/kg/kg-001.spec.ts`

### KG-002: Typed relations with defined semantics
- **Definition:** Every relation type is in the RelationType registry (KNOWLEDGE_GRAPH_DESIGN §3). The `(fromKind, toKind)` of each relation matches the type's signature, and each type declares which claim statuses are allowed for it.
- **Enforcement:** `domain:` RelationType registry; `db:` CHECK on `type` against the registry table.
- **Violation:** REJECT / ABORT_PUBLISH · **Kind:** Hard · **Severity:** HIGH · **Phase:** 03
- **Test:** `tests/invariants/kg/kg-002.spec.ts`

### KG-003: Structural nodes are backed
- **Definition:** Every node of a structural kind (file, directory, module, package, symbol) corresponds 1:1 to a visible backing record, and its `NodeId` is derived from that record's identity. Concept and architecture nodes are not structural and need no backing record.
- **Enforcement:** Nodes are projected by the build pipeline, never inserted directly; `validator:`.
- **Violation:** ABORT_PUBLISH · **Kind:** Hard · **Severity:** HIGH · **Phase:** 03
- **Test:** `tests/invariants/kg/kg-003.spec.ts`

### KG-004: Bounded traversal
- **Definition:** Every `GraphReadModel` traversal requires explicit `maxDepth` and `limit` arguments, both no greater than the server caps. Results report `truncated: true` when a bound was hit.
- **Enforcement:** `type:` required parameters; `domain:` cap clamping.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** HIGH · **Phase:** 03
- **Test:** `tests/invariants/kg/kg-004.spec.ts`

## 5. Provenance invariants (owner: knowledge)

### PV-001: Verified requires deterministic evidence
- **Definition:** A claim with status `verified` at seq `S` has at least one evidence item such that:
  - its `kind` is one of `filesystem | ast | compiler | scip | lsp`;
  - its `seq ≤ S`;
  - its `contentHash` matches the current hash of its locator target at `S`.

  If no such evidence exists, the claim cannot be in `verified` with freshness `current`.
- **Enforcement:** `domain:` ClaimVerifier; `validator:` pre-publish query; StalenessEvaluator.
- **Violation:** DOWNGRADE · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 03
- **Test:** `tests/invariants/pv/pv-001.spec.ts`

### PV-002: No silent promotion
- **Definition:** Claim status changes follow only the transition table in DOMAIN_MODEL §5. A transition into `verified` can only be performed by `ClaimVerifier`, and every transition is recorded with an actor and a reason.
- **Enforcement:** `type:` the `KnowledgeClaim.markVerified()` capability token is only constructible by ClaimVerifier; `domain:` transition guard.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 03
- **Test:** `tests/invariants/pv/pv-002.spec.ts`. Includes a type-level test (`expectTypeOf`/`@ts-expect-error`).

### PV-003: Evidence completeness
- **Definition:** Every evidence item has:
  - `kind`;
  - `producer` (ID and version);
  - `seq`;
  - `contentHash`;
  - a locator, which is either `(path, range)` within the workspace or an `artifact` reference such as `scip:index.scip#…` or `llm:response:<hash>`.
- **Enforcement:** `db:` NOT NULL; `type:`.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 03
- **Test:** `tests/invariants/pv/pv-003.spec.ts`

### PV-004: Staleness is detected
- **Definition:** After revision `N` is published, every claim with an evidence item whose locator content hash changed in `N` has freshness `stale` until it is re-verified. A claim that is `verified` and `stale` is never reported as verified-current.
- **Enforcement:** `domain:` StalenessEvaluator run by the StalenessPropagation application service, inside the same publish transaction.
- **Violation:** DOWNGRADE · **Kind:** Hard · **Severity:** HIGH · **Phase:** 05
- **Test:** `tests/invariants/pv/pv-004.spec.ts`

### PV-005: User assertions are attributed and untouched
- **Definition:** A `user_asserted` claim originates from repo Markdown (page ID and front-matter path) and records that origin. Generators and LLM intake never create, modify or delete `user_asserted` claims.
- **Enforcement:** `domain:` claim factory per origin; `type:`.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** HIGH · **Phase:** 04
- **Test:** `tests/invariants/pv/pv-005.spec.ts`

### PV-006: Inferred claims cite anchors (recommendation)
- **Definition:** An `inferred` claim should cite at least one anchor-resolvable evidence item. Claims with none are flagged in quality reports.
- **Enforcement:** report only.
- **Violation:** none (reported) · **Kind:** Recommendation · **Severity:** MEDIUM · **Phase:** 07
- **Test:** `tests/invariants/pv/pv-006.spec.ts` (report assertion)

## 6. Synchronization invariants (owner: synchronization)

### SN-001: "Current" means fully processed
- **Definition:** Workspace freshness is `current` iff **both** of the following hold:
  - the head revision `H` is `published`;
  - no `ChangeEvent e` affecting an included path exists with `e.seq > H.watermark`.

  Otherwise freshness is `stale` (pending changes) or `unknown` (watcher degraded and no reconciliation since). In addition, `publish(R)` requires `R.watermark ≥ max(seq)` of the ChangeSet it was built from.
- **Enforcement:** `domain:` PublishPolicy, FreshnessEvaluator.
- **Violation:** REJECT (publish) · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01
- **Test:** `tests/invariants/sn/sn-001.spec.ts`

### SN-002: No silent overwrite (compare-and-swap)
- **Definition:** `publish(R)` succeeds iff `head.seq = R.baseSeq` at commit time. Otherwise it fails with `PublishConflict`, and `R` is rebased or abandoned.
- **Enforcement:** `db:` conditional UPDATE (ADR-0015) checked for `changes() = 1`.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01
- **Test:** `tests/invariants/sn/sn-002.spec.ts`

### SN-003: Atomic visibility
- **Definition:** No query at any time observes any row with `valid_from_seq = N` (or `valid_to_seq = N` closures) unless revision `N` is published. Publish of `N` makes all of its rows visible in one transaction.
- **Enforcement:** `adapter:` all reads filter by a pinned seq ≤ head; staging seq > head; single-transaction pointer update.
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01
- **Test:** `tests/invariants/sn/sn-003.spec.ts`. Concurrent reader during a slow staging build, plus a crash-injection test.

### SN-004: Single writer
- **Definition:** At most one index job per workspace holds a valid write lease (`expiresAt > now`). Writes to staging require holding the lease. An expired lease can be taken over, and the takeover abandons the previous holder's staging revision.
- **Enforcement:** `db:` single-row lease table with CAS; `domain:` IndexJob.
- **Violation:** REJECT (`CIE_BUSY`) · **Kind:** Hard · **Severity:** HIGH · **Phase:** 01
- **Test:** `tests/invariants/sn/sn-004.spec.ts`

### SN-005: Recovery from interruption
- **Definition:** On startup, every revision in status `building` or `validating` without a valid lease is either:
  - abandoned (rows rolled back per ADR-0015 §5); or
  - resumed, if its job is resumable and its base still equals head.

  Such a revision is never published without completing validation.
- **Enforcement:** `domain:` RecoveryService at composition-root start.
- **Violation:** n/a (recovery) · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01
- **Test:** `tests/invariants/sn/sn-005.spec.ts`. Uses kill-point crash injection at each pipeline stage.

### SN-006: Responses declare their revision
- **Owner:** runtime (the protocol mapping produces the envelope)
- **Definition:** Every query response includes `revision {seq, freshness}` for the seq it was answered from. Paginated continuations answer from the same seq or fail with `CIE_REVISION_UNAVAILABLE`.
- **Enforcement:** `type:` the response envelope type; `adapter:` protocol mapping.
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** HIGH · **Phase:** 06
- **Test:** `tests/invariants/sn/sn-006.spec.ts`

### SN-007: Published revisions are immutable
- **Definition:** For a published revision `P`, the set of rows visible at `P` never changes while `P` is retained. The only permitted mutations of `P`'s rows are:
  - setting `valid_to_seq` to a later published or staging seq;
  - garbage-collection deletion after `P` leaves retention.
- **Enforcement:** `adapter:` RevisionWriter API exposes no update of visible content; `validator:` digest comparison in tests.
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01
- **Test:** `tests/invariants/sn/sn-007.spec.ts`

### SN-008: Stale references are detectable
- **Definition:** For any anchor, link or evidence locator recorded at seq `S < head`, `AnchorResolver` determines `resolved | redirected | drifted | deleted` using only the head revision, lineage records and the stored spanHash. No full re-index is needed.
- **Enforcement:** `domain:` AnchorResolver.
- **Violation:** n/a · **Kind:** Hard · **Severity:** HIGH · **Phase:** 05
- **Test:** `tests/invariants/sn/sn-008.spec.ts`

## 7. Documentation invariants (owner: documentation)

### DOC-001: Ownership is explicit
- **Definition:** Every byte of a wiki page belongs to exactly one section:
  - bytes between a matched `<!-- cie:begin … -->` / `<!-- cie:end … -->` pair are **generated**;
  - all other bytes, including front matter except the `cie.generated` block, are **user-owned**.
- **Enforcement:** `domain:` PageParser/WikiPage.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 04
- **Test:** `tests/invariants/doc/doc-001.spec.ts`

### DOC-002: Hash-guarded generated writes
- **Definition:** The generator may replace a generated section only if `sha256(current on-disk section content) = section.writtenHash`, the hash recorded at the last generator write. If the hashes differ, a `Conflict` is recorded, the proposal is written to `.cie/conflicts/`, and the page file is not modified.
- **Enforcement:** `domain:` SectionWriteGuard; `adapter:` PageStore performs a read-compare-write under a file lock, with an atomic rename.
- **Violation:** CONFLICT · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 04
- **Test:** `tests/invariants/doc/doc-002.spec.ts`

### DOC-003: User regions are preserved byte-for-byte
- **Definition:** After any generator write, all user-owned bytes of the page are byte-identical to before the write, including line endings and BOM.
- **Enforcement:** `domain:` splice-only writer (it replaces only the generated range).
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 04
- **Test:** `tests/invariants/doc/doc-003.spec.ts`. Property-based test over random pages, CRLF/LF and BOM.

### DOC-004: Links are resolved and broken links are reported
- **Definition:** For each revision, every link (`cie:` URI or `[[…]]` wiki link) in every page is classified as `resolved | redirected | stale | broken`. `wiki.validate` returns all `broken` and `stale` links with page and position.
- **Enforcement:** `domain:` LinkResolver.
- **Violation:** none (reported; CI-blocking only in `--strict` mode) · **Kind:** Hard (detection) · **Severity:** HIGH · **Phase:** 04
- **Test:** `tests/invariants/doc/doc-004.spec.ts`

### DOC-005: Stable, unique page identity
- **Definition:** Every page has a front-matter `cie.id` that is unique in the workspace. Renaming or moving the file does not change the ID. Duplicate IDs make both pages invalid until resolved.
- **Enforcement:** `domain:` page registry.
- **Violation:** REJECT (both pages flagged) · **Kind:** Hard · **Severity:** HIGH · **Phase:** 04
- **Test:** `tests/invariants/doc/doc-005.spec.ts`

### DOC-006: Generated sections know their sources
- **Definition:** Every generated section records the `seq` it was generated at and the IDs (symbols, claims) it was derived from. If any of those sources is changed, deleted or stale at head, the section is marked `stale`.
- **Enforcement:** `domain:` SectionStaleness.
- **Violation:** DOWNGRADE · **Kind:** Hard · **Severity:** HIGH · **Phase:** 05
- **Test:** `tests/invariants/doc/doc-006.spec.ts`

### DOC-007: Malformed markers freeze generation
- **Definition:** If a page has unpaired, nested, overlapping or duplicate-ID markers, the generator performs **no** writes to that page and reports `MALFORMED_MARKERS`.
- **Enforcement:** `domain:` PageParser.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** HIGH · **Phase:** 04
- **Test:** `tests/invariants/doc/doc-007.spec.ts`

### DOC-008: Concept pages link to code (recommendation)
- **Definition:** A concept page should reference at least one symbol or file, or declare `cie.abstract: true`.
- **Enforcement:** report.
- **Violation:** none · **Kind:** Recommendation · **Severity:** MEDIUM · **Phase:** 04
- **Test:** `tests/invariants/doc/doc-008.spec.ts`

## 8. AI invariants (owner: knowledge, via InferenceIntake)

### AI-001: AI cannot invent source locations
- **Definition:** LLM output may reference code only through anchor IDs, symbol IDs or claim IDs that were included in the prompt context. Any other location-like content (paths, line numbers, unknown IDs) is discarded and never persisted as a location or relation endpoint.
- **Enforcement:** `domain:` InferenceIntake ID resolution against the prompt's allow-list; `type:` the intake output contains only `SymbolId`/`AnchorId` references.
- **Violation:** REJECT (item dropped, counted) · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 07
- **Test:** `tests/invariants/ai/ai-001.spec.ts`. Uses a fake model emitting fabricated paths.

### AI-002: AI cannot change verification status
- **Definition:** Claims created from LLM output have status `inferred` or `unknown`. No LLM-facing component can obtain the `markVerified` capability, and LLM output can never alter an existing claim's status.
- **Enforcement:** `type:` capability token (PV-002); `ci:` depcruise rule forbidding `adapters/llm-*` → `knowledge/domain/verification` (FF-BND-005).
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 07
- **Test:** `tests/invariants/ai/ai-002.spec.ts`

### AI-003: Insufficient evidence is a valid answer
- **Definition:** Every LLM output schema includes `{"status": "insufficient_evidence"}` as a valid alternative. Outputs failing schema validation are rejected and never coerced. Rejected or insufficient answers create no claims and render as "unknown" in the UI.
- **Enforcement:** `domain:` InferenceIntake schema validation.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** HIGH · **Phase:** 07
- **Test:** `tests/invariants/ai/ai-003.spec.ts`

### AI-004: The LLM is optional
- **Owner:** runtime (composition root and CI configuration)
- **Definition:** With `llm.provider = none`, all FR requirements except FR-060..065 pass their tests. CI runs the default suite with `llm-none`.
- **Enforcement:** `ci:` the default test configuration.
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** HIGH · **Phase:** 01
- **Test:** `tests/invariants/ai/ai-004.spec.ts`

## 9. Security and API invariants

**Owners:** SEC-001 → knowledge (PromptBuilder) · SEC-002, SEC-003, SEC-004, SEC-005 → runtime · SEC-006 → vscode-extension · API-001..003 → runtime. These are not domain-context invariants, but they are governed in the same register.

### SEC-001: Repository content is never instructions
- **Definition:** Repo-derived text placed in an LLM prompt sits only inside delimited untrusted-content blocks under a fixed system prompt. Repo-derived text never selects tools, providers, endpoints or file targets.
- **Enforcement:** `domain:` PromptBuilder (the only constructor of LlmRequest).
- **Violation:** CI_FAIL · **Kind:** Hard (mechanism); effectiveness is tested adversarially and cannot be proven · **Severity:** HIGH · **Phase:** 07
- **Test:** `tests/invariants/sec/sec-001.spec.ts`

### SEC-002: No code execution; confined writes
- **Owner:** runtime
- **Definition:** CIE never spawns processes derived from repository content: no package scripts, build tools or project-configured commands. The only spawn exceptions are listed in the SEC-002 exception register (SECURITY_AND_RELIABILITY §2, e.g. user-enabled SCIP indexers). CIE writes only under `.cie/` and the configured `wiki.dir`, apart from the explicitly authorized write exceptions in the same section (`.gitignore` on confirmed `init`, `--state-dir`, the user config dir).
- **Enforcement:** `adapter:` FileSystem write guard; `ci:` depcruise forbids `node:child_process` outside `adapters/process` (FF-DEP-007).
- **Violation:** REJECT / CI_FAIL · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01
- **Test:** `tests/invariants/sec/sec-002.spec.ts`

### SEC-003: Remote LLM calls are guarded
- **Definition:** A request reaches a `locality: remote` provider only if (a) consent for this workspace exists in the user config directory, and (b) the payload has passed through `SecretRedactor`, with secret-pattern files excluded.
- **Enforcement:** `adapter:` GuardedProvider wrapping all remote providers in the composition root; `ci:` remote adapters are not exported except through the guard.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 07
- **Test:** `tests/invariants/sec/sec-003.spec.ts`

### SEC-004: The query profile is read-only
- **Definition:** No query-profile method writes to source files, wiki files or `.cie/` stores. Read-side caches are the only exception. MCP exposes only query-profile methods.
- **Enforcement:** `adapter:` method registry tags each method `query|control`; the MCP adapter filters on the tag; query handlers receive read-only ports.
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 06
- **Test:** `tests/invariants/sec/sec-004.spec.ts`

### SEC-005: Sensitive settings never come from the workspace
- **Definition:** `llm.*`, consent, endpoints, `wiki.publishGenerated`, enricher commands and telemetry settings are read only from user-level configuration or VS Code user settings, never from any file inside the workspace. A workspace `cie.config.json` containing such keys is rejected.
- **Enforcement:** `adapter:` ConfigLoader with an allow-list schema per source.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** CRITICAL · **Phase:** 01
- **Test:** `tests/invariants/sec/sec-005.spec.ts`

### SEC-006: Webview isolation
- **Definition:** The Webview receives only protocol DTOs and rendered-safe data:
  - Markdown is rendered with raw HTML disabled, and the output is sanitized.
  - Every inbound Webview message is schema-validated by the host before any action.
  - The CSP is `default-src 'none'` plus nonce-based scripts.
  - `localResourceRoots` is restricted to the extension's webview dist.
- **Enforcement:** `adapter:` extension host message router.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** HIGH · **Phase:** 06
- **Test:** `tests/invariants/sec/sec-006.spec.ts`

### API-001: Versioned, stable DTOs
- **Definition:** `@cie/protocol` follows semver per API major version (`v1`). Removing or renaming fields, narrowing types or changing semantics requires a new major version. Additive optional fields are minor changes. Contract snapshot tests detect changes.
- **Enforcement:** `ci:` API extractor snapshot diff (FF-BND-006).
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** HIGH · **Phase:** 09
- **Test:** `tests/invariants/api/api-001.spec.ts`

### API-002: Bounded, revision-pinned results
- **Definition:** Every list response has `limit ≤ serverMaxLimit`. A continuation cursor encodes the revision seq, and continuations never mix revisions.
- **Enforcement:** `type:` + `adapter:` clamp.
- **Violation:** REJECT · **Kind:** Hard · **Severity:** HIGH · **Phase:** 06
- **Test:** `tests/invariants/api/api-002.spec.ts`

### API-003: Registered error codes, no internal leakage
- **Definition:** Every error response carries a code from the registered `CieErrorCode` union. Messages never contain absolute paths outside the workspace, stack traces or secret values.
- **Enforcement:** `adapter:` error mapper.
- **Violation:** CI_FAIL · **Kind:** Hard · **Severity:** MEDIUM · **Phase:** 06
- **Test:** `tests/invariants/api/api-003.spec.ts`

## 10. Traceability

| Brief §4 item | Invariants |
|---|---|
| Source references belong to a valid workspace | WS-001, WS-002 |
| Workspace isolation | WS-003, SEC-005 |
| Symbol identity stable within scope | SY-001, SY-002 |
| Source locations verifiable | SY-003, SY-005 |
| Renamed, moved or deleted handled explicitly | SY-004, SN-008 |
| Relationships cannot reference nonexistent nodes | KG-001, KG-003 |
| Graph integrity | KG-001..004 |
| Relationship types have defined semantics | KG-002 |
| Verified claims require evidence | PV-001 |
| No silent promotion | PV-002, AI-002 |
| Evidence identifies source and revision | PV-003 |
| Index not current while changes are unprocessed | SN-001 |
| Concurrent jobs do not overwrite | SN-002, SN-004 |
| Partial updates not published | SN-003, SN-005 |
| Stale references detectable | SN-008, PV-004, DOC-006 |
| User vs generated content distinguishable | DOC-001 |
| AI does not overwrite user material | DOC-002, DOC-003, PV-005 |
| Broken links detectable | DOC-004 |
| AI cannot invent locations | AI-001 |
| AI cannot change verification status | AI-002 |
| Unknown / insufficient-evidence state | AI-003, ClaimStatus `unknown` |

**Counts.** 49 invariants: 24 CRITICAL, 22 HIGH, 3 MEDIUM (of which 2 are recommendations: PV-006, DOC-008).

**CRITICAL invariants by phase** (these drive the phase gates in IMPLEMENTATION_ROADMAP):

| Phase | CRITICAL invariants |
|---|---|
| 01 | WS-001, WS-002, WS-003, SN-001, SN-002, SN-003, SN-005, SN-007, SEC-002, SEC-005 |
| 02 | SY-001, SY-002, SY-003, KG-001 |
| 03 | PV-001, PV-002, PV-003 |
| 04 | DOC-001, DOC-002, DOC-003 |
| 06 | SEC-004 |
| 07 | AI-001, AI-002, SEC-003 |
