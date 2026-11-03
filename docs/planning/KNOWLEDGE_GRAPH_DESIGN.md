# Knowledge Graph Design

> Status: Baseline v0.1 · Related: ADR-0008, ADR-0014, ADR-0015, KG-*, PV-*, SN-* invariants

## 1. Design goals

1. **One graph, two kinds of claims.**
   - *Structural edges* are high-volume and deterministic. Their evidence is **intrinsic**: producer, path, range and file hash are stored inline.
   - *Semantic claims* are low-volume and come from LLMs, heuristics or users. Their evidence is **explicit**: evidence rows.
2. **Revision-scoped everything**, using validity intervals (ADR-0015).
3. **Bounded queries only** (KG-004, FF-PRF-004). No query loads the whole graph.
4. **The SQLite index is rebuildable** from source plus repo Markdown plus the `state.db` LLM cache (NFR-020).

## 2. Node types

| Kind | ID scheme (`NodeId`) | Structural? | Backing record | Created by |
|---|---|---|---|---|
| `workspace` | `ws:` | yes | Workspace | init |
| `directory` | `dir:<path>` | yes | manifest | enumeration |
| `file` | `file:<path>` | yes | FileRecord | enumeration |
| `package` | `pkg:npm:<name>` / `pkg:py:<name>` (workspace-local) | yes | package.json / pyproject / `__init__` root | Phase 01 |
| `module` | `mod:<lang>:<path>` | yes | FileRecord (a module is the language view of a file) | Phase 02 |
| `symbol` | `SymbolId` (ADR-0014) | yes | SymbolRecord | Phase 02 |
| `external` | `ext:npm:<name>` / `ext:pypi:<name>` / `ext:node:<builtin>` / `ext:python:<stdlib module>` (built-ins and standard library, added in Phase 02) | yes | import resolution | Phase 02 |
| `unresolved` | `unres:<lang>:<path>#<siteHash>` | yes | the unresolved site (SY-006) | Phase 02 |
| `concept` | `concept:<slug>` | no | Concept aggregate (Markdown or AI proposal) | Phase 04 / 07 |
| `component` | `comp:<slug>` | no | Architecture model (derived from packages, or user-declared) | Phase 08 |
| `layer` | `layer:<slug>` | no | User-declared architecture rules | Phase 08 |
| `page` | `PageId` (front matter) | no | WikiPage | Phase 04 |

## 3. Relation types (registry, KG-002)

**Status legend:** V = verified, I = inferred, U = user_asserted, ? = unknown.

| Type | Signature (from → to) | Semantics | Allowed statuses | Producer kinds |
|---|---|---|---|---|
| `contains` | directory→directory, package→directory, symbol→symbol | Lexical or physical containment | V | filesystem, ast |
| `defines` | module→symbol | Module-level definition | V | ast, compiler |
| `exports` | module→symbol | Symbol is exported from the module (incl. re-exports, with `via`) | V, I | compiler (V), ast/heuristic (I) |
| `imports` | module→module, module→external, module→unresolved | Static import dependency (`isTypeOnly`, `isDynamic` attrs) | V, I, ? | compiler (V), heuristic (I), — (?) |
| `imports_symbol` | module→symbol, module→unresolved | Named import binding | V, I, ? | compiler, heuristic, — (?) |
| `references` | symbol→symbol, module→symbol | Identifier occurrences in `from`'s body (or top-level code) resolve to `to`; one edge per pair, `occurrences` counts them | V, I | compiler, scip, heuristic |
| `calls` | symbol→symbol, symbol→unresolved, module→symbol, module→unresolved | A static call expression targets `to`; one edge per call site | V, I, ? | compiler, scip, heuristic |
| `may_dispatch_to` | symbol(method)→symbol(method) | Virtual or interface call may reach an implementer | I | compiler + analysis, heuristic |
| `extends` | symbol→symbol | Class or interface inheritance | V, I | compiler, heuristic |
| `implements` | symbol→symbol | Class implements interface | V | compiler |
| `references_type` | symbol→symbol, module→symbol | Type-position references; one edge per pair, `occurrences` counts them | V, I | compiler, heuristic |
| `injects` | symbol→symbol | DI wiring (constructor injection etc.) | I | heuristic:di-* |
| `depends_on` | component→component, package→package | Aggregated dependency (derived from `imports`) | V (derived from V edges only) / I | derivation |
| `belongs_to` | directory/package/module→component, component→layer | Architecture membership | V (rule-based from config), U | architecture rules, user |
| `violates` | component→component | A `depends_on` edge breaks a declared layer rule | V | rule evaluation |
| `describes` | page→concept / page→symbol / page→component | The page is about the target | U (front matter), I | markdown, llm |
| `mentions` | page→any | The page links to the target (from link resolution) | V | link resolver |
| `implements_concept` | symbol/module/component→concept | The code realizes the concept | U, I, ? | user, llm |
| `related_to` | concept→concept | Generic association | U, I | user, llm |
| `part_of` | concept→concept | Concept hierarchy | U, I | user, llm |
| `flow_step` | symbol→symbol | Ordered step in a declared or traced execution flow (attrs: `flowId`, `order`) | V (from V calls), I | flow tracer, user |
| `lineage` | symbol→symbol | Identity change: `moved` / `renamed` (SY-004) | V | SymbolMatcher |

**Implementation (P03-04).**
- The registry lives in `core/knowledge/domain/relation-type.ts` (`RELATION_TYPES`, `relationViolations`). Each type records its signatures, allowed statuses, whether it is occurrence-based (`references`, `calls`: non-empty site key) and the phase that introduces it.
- `tests/invariants/kg/kg-002.spec.ts` keeps this table and the registry in sync, by type name and order.
- Deviations from the v0.1 table:
  - There is no `file` node kind. A file's graph view is its `module` node, so file→symbol containment is `defines`, `belongs_to` starts at directory, package or module, and `contains` has no file endpoints.
  - `imports_symbol` also targets `unresolved` placeholders with status `unknown`, as Phase 02 resolvers emit them (SY-006).
- P03-07 changes:
  - `references`, `references_type` and `calls` may start at a `module` (top-level code).
  - `references` is no longer occurrence-based. Only `calls` is.
- Enforcement:
  - Compile time: `RegisteredCodeEdgeType` and `RegisteredEdgeStatus` fail to compile if code-intelligence emits a type or status that the registry does not know.
  - Store: the RevisionValidator checks every visible edge (type, endpoint kinds from `node_key.kind`, status, site key) and aborts the publish on a violation.
  - The `relation_type` table (with a foreign key from `edge.type`) comes with P03-09.

**Implementation (P03-07): references, calls and type relations (TS/JS, lang-ts at L3).**
- **Edges.** `references`, `references_type`, `calls`, `extends` and `implements`. They are built by `createRelationEdge` (core `code-intelligence/domain/relation-edge.ts`), which applies SY-006 at construction like `createImportEdge`.
- **Sources.** The source is the innermost extracted symbol around the occurrence, or the module for top-level code. A call inside an object-literal method belongs to the extracted symbol that holds the literal.
- **What counts.**
  - An identifier that tsc binds, through import aliases, to an extracted workspace symbol is a reference. It is `references_type` in a type position and `references` otherwise.
  - Not references: declaration names, import and export declarations (they are imports), and heritage clauses (they are `extends` and `implements`).
  - Every call or `new` whose callee binds to an extracted symbol is a `calls` edge, so it is also counted as a reference.
- **Unresolved (SY-006).**
  - A `calls` edge goes to a per-site `unresolved` placeholder when the callee is syntactically dynamic (`handlers[k]()`, `make()()`).
  - It also does when tsc cannot bind the callee and the callee chain is rooted in a workspace value, for example an `any` parameter or a value whose type came from an unresolved import.
  - Only `calls` gets placeholders.
- **Not recorded.**
  - Targets outside the workspace: lib declarations, external packages, undeclared globals. The package dependency is already an `imports` edge.
  - Declarations that are not extracted symbols: parameters, locals, object-literal members.
  - `super()`, `import()`, `require()`.
- **Granularity.** `calls` is one edge per site (`site` = hash of the call range), as flows need (§8.7). The other four types are one edge per (from, to). The projection keeps the earliest occurrence as evidence and counts the rest in `attrs.occurrences`.
- **Storage.** Schema v6 (the `edge.type` CHECK). The RevisionValidator's SY-006 check covers every resolved type.
- **Truth.** The `ts-relations` golden fixture has hand-verified relations (`fixtures/ts-relations.truth.json`, category `relations`). The guards for locals and for chains outside the workspace were mutation-checked through its golden export.

**Implementation (P03-08): Python references and calls (lang-python at L2, inferred).**
- **Split.** The tree-sitter extractor reports *free-name uses* as syntax facts (`FileExtraction.occurrences`, Python only; declared as `references` L1). lang-python binds them; it never parses (DEPENDENCY_RULES A1/A2).
- **What the extractor reports** (`adapters/treesitter/python-scopes.ts`):
  - an identifier that is not a declaration name, an attribute name (`x.y` reports `x` only), a keyword-argument name, or part of an import, `global` or `nonlocal` statement;
  - and that is not bound in an enclosing function scope.
- **Function scopes.**
  - Bindings: parameters, assignment, augmented-assignment and `for` targets, `with`/`except … as`, walrus, local imports, nested `def`/`class`. They count wherever they appear in the body.
  - `global` refers to the module; `nonlocal` stays local.
  - Comprehensions and lambdas are scopes.
  - Defaults, annotations, decorators and base classes are evaluated outside the function.
  - Class bodies are not scopes for their methods, and class-level assignment targets are declarations.
- **What lang-python records** (`adapters/lang-python/relations.ts`).
  - The module scope is the file's top-level symbols plus the names that `from X import n` resolved to a symbol. A definition wins over an import of the same name.
  - Every use of a bound name is a `references` occurrence (merged per (from, to)).
  - A direct call `name(…)` is also a `calls` edge for that site.
  - All of these edges are `heuristic` / `inferred`.
- **Not recorded.**
  - Attribute calls (`obj.m()`, `module.f()`), because the type is unknown at L2.
  - Builtins, and module objects from `import x [as y]`.
  - Calls of local functions (`inner()` inside `outer`).
  - There are no unresolved placeholders for Python: an unbound name is not evidence of a dynamic call.
- **Known gap:** `from X import a as b` does not bind `b`, because import drafts keep only the exported name.
- **Truth:** the `py-relations` golden fixture, plus the `relations` categories of `py-basic` and `py-src-layout`. The local-scope, `global` and default-value guards were mutation-checked through the golden. The default-value case first survived a mutant, and the fixture was extended until it failed.

**Distinguishing the four relationship classes** (brief §7):

| Class | How it is represented |
|---|---|
| Verified structural | `edge.status = 'verified'`, `precision = 'exact'`, intrinsic evidence from a deterministic producer |
| Inferred semantic | `status = 'inferred'`; a claim with explicit evidence rows (LLM response artifact, heuristic producer) |
| User-authored | `status = 'user_asserted'`, `origin = page:<PageId>#frontmatter` |
| Unknown / unresolved | `status = 'unknown'` and/or an edge to an `unresolved` node, or a claim answering `insufficient_evidence` |

## 4. Stable identifiers

| ID | Derivation |
|---|---|
| Structural node IDs | Derived from structural identity (path, `SymbolId`), so they are stable across rebuilds (KG-003) |
| Concept IDs | Slug from the front-matter `cie.id` / `concept` key, which is user-controlled and stable. AI-proposed concepts get `concept:ai-<hash(title)>` until a user adopts them. |
| Edge identity | `(type, from, to, siteKey)`, where `siteKey` is the call-range hash for the occurrence-based type `calls` and empty otherwise. `references` and `references_type` are one edge per pair with an occurrence count (P03-07: per-occurrence rows would multiply edge volume, R-06) |
| Claim IDs | `claim:<hash(subject, predicate, object, origin)>`. Deterministic, so re-intake of the same LLM output does not duplicate claims. |
| Evidence IDs | `ev:<hash(kind, producer, locator, contentHash)>` |

## 5. SQL schema sketch (`index.db`)

This is a specification for Phase 01–03. Column types are SQLite affinities. Every table marked (R) is revision-scoped with `valid_from_seq INTEGER NOT NULL, valid_to_seq INTEGER NULL`.

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);  -- workspace_id, schema_version, producer versions

CREATE TABLE workspace_head (           -- single row; ADR-0015
  id INTEGER PRIMARY KEY CHECK (id = 1),
  current_seq INTEGER NOT NULL,
  watermark INTEGER NOT NULL
);
CREATE TABLE index_revision (
  seq INTEGER PRIMARY KEY, base_seq INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('building','validating','published','superseded','abandoned')),
  watermark INTEGER NOT NULL, manifest_hash TEXT, job_id TEXT NOT NULL,
  created_at TEXT NOT NULL, published_at TEXT
);
CREATE TABLE index_lease (id INTEGER PRIMARY KEY CHECK (id = 1), holder TEXT, expires_at TEXT);

-- Stable identity keys: NOT revision-scoped, append-only, garbage-collected with the last referencing version.
-- Versioned rows reference these keys, so a new version of a node (e.g. a shifted range) never
-- invalidates edges that point at it (SN-007 + KG-001 together; see the contradiction log C-02).
CREATE TABLE file_key (key INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE);
CREATE TABLE node_key (key INTEGER PRIMARY KEY, node_id TEXT NOT NULL UNIQUE, kind TEXT NOT NULL);

CREATE TABLE file (                     -- (R) one row per file *version*
  rowid INTEGER PRIMARY KEY, file_key INTEGER NOT NULL REFERENCES file_key(key),
  hash TEXT NOT NULL, size INTEGER NOT NULL, line_count INTEGER,
  lang TEXT, status TEXT NOT NULL,      -- indexed | skipped:<reason>
  valid_from_seq INTEGER NOT NULL, valid_to_seq INTEGER
);
CREATE INDEX file_key_vis ON file(file_key, valid_to_seq);

CREATE TABLE node (                     -- (R) one row per node *version*, all node kinds
  rowid INTEGER PRIMARY KEY, node_key INTEGER NOT NULL REFERENCES node_key(key), kind TEXT NOT NULL,
  name TEXT, qualified_name TEXT, file_key INTEGER REFERENCES file_key(key),
  start_line INTEGER, start_col INTEGER, end_line INTEGER, end_col INTEGER,
  span_hash TEXT, body_fingerprint TEXT, exported INTEGER, symbol_kind TEXT,
  producer TEXT NOT NULL, fidelity TEXT NOT NULL, attrs TEXT,  -- JSON (small)
  valid_from_seq INTEGER NOT NULL, valid_to_seq INTEGER
);
CREATE INDEX node_key_vis  ON node(node_key, valid_to_seq);
CREATE INDEX node_file_vis ON node(file_key, valid_to_seq);
CREATE UNIQUE INDEX node_head_unique ON node(node_key) WHERE valid_to_seq IS NULL;  -- SY-002 (head)

CREATE TABLE relation_type (name TEXT PRIMARY KEY, from_kinds TEXT NOT NULL, to_kinds TEXT NOT NULL,
  allowed_status TEXT NOT NULL);       -- seeded from the §3 registry (KG-002)

CREATE TABLE edge (                     -- (R) structural + semantic relations
  rowid INTEGER PRIMARY KEY,
  type TEXT NOT NULL REFERENCES relation_type(name),
  from_key INTEGER NOT NULL REFERENCES node_key(key),   -- FK guarantees identity exists;
  to_key   INTEGER NOT NULL REFERENCES node_key(key),   -- RevisionValidator guarantees visibility at seq (KG-001)
  site_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('verified','inferred','user_asserted','unknown')),
  freshness TEXT NOT NULL DEFAULT 'current' CHECK (freshness IN ('current','stale')),
  precision TEXT CHECK (precision IN ('exact','heuristic')),
  -- intrinsic evidence (structural)
  ev_kind TEXT, ev_producer TEXT, ev_file_key INTEGER REFERENCES file_key(key),
  ev_start_line INTEGER, ev_start_col INTEGER, ev_end_line INTEGER, ev_end_col INTEGER, ev_content_hash TEXT,
  claim_id TEXT,                        -- set for semantic edges (explicit evidence in claim_evidence)
  attrs TEXT,
  valid_from_seq INTEGER NOT NULL, valid_to_seq INTEGER
);
CREATE INDEX edge_out ON edge(from_key, type, valid_to_seq);
CREATE INDEX edge_in  ON edge(to_key,   type, valid_to_seq);

CREATE TABLE claim (                    -- (R) semantic claims (non-edge too: attribute claims)
  rowid INTEGER PRIMARY KEY, claim_id TEXT NOT NULL, subject_key INTEGER NOT NULL REFERENCES node_key(key),
  predicate TEXT NOT NULL, object_key INTEGER REFERENCES node_key(key), object_value TEXT,
  status TEXT NOT NULL, freshness TEXT NOT NULL, origin TEXT NOT NULL,  -- llm:<model> | heuristic:<id> | page:<PageId>
  author TEXT,                          -- required when status = user_asserted (PV-005)
  valid_from_seq INTEGER NOT NULL, valid_to_seq INTEGER
);
CREATE TABLE evidence (                 -- (R) explicit evidence (PV-003)
  rowid INTEGER PRIMARY KEY, evidence_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('filesystem','ast','compiler','scip','lsp','heuristic','llm','user')),
  producer TEXT NOT NULL, seq INTEGER NOT NULL, content_hash TEXT NOT NULL,
  file_key INTEGER REFERENCES file_key(key), start_line INTEGER, start_col INTEGER, end_line INTEGER, end_col INTEGER,
  artifact TEXT,                        -- e.g. llm:response:<hash>, scip:<file>#<occ>
  CHECK (file_key IS NOT NULL OR artifact IS NOT NULL),
  -- content_hash pins the file *version* the evidence was observed in (historical evidence allowed; PV-004 decides freshness)
  valid_from_seq INTEGER NOT NULL, valid_to_seq INTEGER
);
CREATE TABLE claim_evidence (            -- (R) links by stable IDs, so a new claim version keeps its evidence links
  claim_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  valid_from_seq INTEGER NOT NULL, valid_to_seq INTEGER, PRIMARY KEY (claim_id, evidence_id, valid_from_seq));
CREATE TABLE claim_transition (claim_id TEXT NOT NULL, seq INTEGER NOT NULL, from_status TEXT, to_status TEXT NOT NULL,
  actor TEXT NOT NULL, reason TEXT NOT NULL);          -- PV-002 audit (append-only)

CREATE TABLE lineage (from_symbol TEXT NOT NULL, to_symbol TEXT, kind TEXT NOT NULL
  CHECK (kind IN ('moved','renamed','deleted')), at_seq INTEGER NOT NULL);

CREATE VIRTUAL TABLE search_fts USING fts5(           -- ADR-0008 (A-03); keyed by stable node_key
  node_key UNINDEXED, name, qualified_name, path, doc, tokenize = 'unicode61 remove_diacritics 2');
-- FTS is head-only: rebuilt for changed nodes at publish time inside the publish transaction.

CREATE TABLE page (...);  CREATE TABLE section (...);  CREATE TABLE link (...);   -- see DOCUMENTATION_MODEL §9
```

**Implemented in Phase 02 (P02-08, `index.db` schema v3, `packages/adapters/src/sqlite/schema.ts` and `graph-store.ts`).** These differences from the sketch are deliberate:
- **One `node` table for all kinds.** Structural nodes (directory, package, project) and code nodes (module, symbol, external, unresolved) share the table and `node_key`. Code nodes must carry `producer`, `fidelity` and `data` (a CHECK constraint, SY-005). `data` is the canonical JSON of the projected record, and equal `data` means the same version during staging.
- **No `file:` nodes yet.** A module is the language view of a file and is backed by the file row. For that reason Phase 02 has no `contains` edges from a directory to a file.
  - `contains` links a symbol to its nested symbols.
  - `defines` links a module to its top-level symbols.
  - `exports` links a module to its exported top-level symbols.
- **Precision of syntactic edges (contradiction log C-14).** `contains`, `defines` and `exports` come from the parser and are not resolutions, so their precision is null. Their status is `verified`, except Python `exports`, which follow a naming convention and are `inferred`. SY-006 (precision vs fidelity) governs the resolved edge types (`imports`, `imports_symbol`, and in Phase 03 `references`, `calls` and type relations).
- **Edge identity is `(type, from, to, site_key)`** with a partial unique index on the head. Several import statements with the same identity merge into one edge that keeps the earliest statement as evidence.
- **Staging has three mandatory steps:** manifest, then structure, then code graph. A revision with an empty graph must still stage it, so a forgotten step cannot look complete.
- **RevisionValidator checks added in Phase 02:**
  - KG-001: both endpoints of a visible edge are visible;
  - SY-002: duplicate node ids or edge identities;
  - SY-005: missing attribution;
  - SY-006: import edges re-checked with `importEdgeViolations`; syntactic edges must not claim a precision;
  - WS-001: edge evidence must point at a visible file.
- In Phase 02, `line_count` was not stored and SY-003 was enforced only by the extractor and its tests. Phase 03 (P03-02, schema v5) adds the check at publish; see below.
- **SY-003 at publish (P03-02, schema v5).**
  - `file.line_count` holds the line count of the decoded content. It is a pure function of the hash, carried in `CodeGraph.files` and written by graph staging, which also refuses facts whose content hash differs from the manifest version (`SY_003_CONTENT_MISMATCH`). Staging fills the value in place only on rows the staging revision introduced. A published row without it (the file was never extracted before) is closed and re-versioned, never updated (SN-007). The value is not exported.
  - The RevisionValidator checks bounds for every visible symbol in SQL: the range is well formed, it ends before `line_count`, and the file version has a line count.
  - Span hashes are rehashed for a deterministic sample of the stored symbols (every k-th in node-id order; `RevisionWriter.sampleSpans`). IndexService re-reads those files through the FileSystem port (`synchronization/application/span-check.ts`) before `decidePublish`. A file whose bytes no longer match the stored hash is counted as unverifiable, not as a violation. The default sample is 200 (`DEFAULT_SPAN_SAMPLE`); tests rehash every symbol.
- **Schema v4 (P02-09) adds `search_fts`.** It holds symbols only and is keyed by the symbol's `node.id` row version, not by `node_key`, so a row maps to exactly one version. Its columns are `name`, `qualified_name`, `words` (identifier words, so `store` finds `SessionStore`), `path` and `doc`, tokenized with `unicode61 remove_diacritics 2`.
  - It is maintained in the publish transaction: rows of versions closed at the seq are deleted, rows of versions introduced at the seq are inserted.
  - Reads join back to `node` with the visibility filter, and search is head-only (`SEARCH_HEAD_ONLY`).
  - Ranking is bm25 (name 10, qualified name 5, words 3, path 1, doc 0.5), with ties broken by id.
  - User text is reduced to letter/digit terms in core (`searchTerms`), and each term is passed only as a quoted prefix token, so query syntax cannot be injected.

**Visibility filter.** Every read applies `valid_from_seq <= :seq AND (valid_to_seq IS NULL OR valid_to_seq > :seq)`. Repository code generates the predicate, and FF-BND-003 forbids raw SQL elsewhere.

**FTS and revisions.** FTS indexes **head only**. Queries pinned to an older seq re-check visibility by joining back to `node` with the visibility filter, and may miss names that changed since. This is accepted for search. [Proposal]

## 6. Workspace and revision scoping

- **Workspace scoping is physical.** One `index.db` per workspace, checked against `meta.workspace_id` (WS-003). No `workspace_id` column is needed.
- **Revision scoping** uses validity intervals (ADR-0015). Garbage collection keeps `retention.keepRevisions` revisions (default [Proposal]: 3), plus any revision pinned by an open cursor.

## 7. Incremental graph update algorithm (Phase 05)

Input: head `H`, ChangeSet `C` (paths with hints).

1. **Confirm the changes.** Rehash the candidate paths. `Changed` = {hash differs}, `Added`, `Removed`. Paths whose hash is unchanged are dropped (hints are not truth).
2. **Begin staging revision** `N = H + 1` under the lease.
3. **Files.** Close the rows for removed and changed files (`valid_to_seq = N`), and insert new rows for added and changed files.
4. **Extract.** Run `FileExtractor` on Changed ∪ Added.
5. **Match symbols** (SY-004). For each changed file, compare the old symbols (visible at `H`) with the new extraction:
   - The same `SymbolId` with the same `spanHash` is `unchanged`. If its range shifted, a **new node version** is written (old row closed at N, new row from N, same `node_key`). Visible rows are never updated in place (SN-007), and edges keyed by `node_key` stay valid.
   - The same `SymbolId` with a different `spanHash` is `modified`.
   - An old ID that is missing while a new ID has an equal `bodyFingerprint`, the same kind and the same container is `renamed` (if in the same file) or `moved` (if in another changed or added file). This step is global across the ChangeSet.
   - Anything else is `deleted` or new.
   - Lineage rows are written for moved, renamed and deleted symbols.
6. **Affected set.**
   - Dependents come from `edge_in` on `imports` and `imports_symbol` of the changed modules, plus any `ProjectResolver.affectedFiles`.
   - Edges *originating* in Changed ∪ Affected are closed and re-resolved. Edges *targeting* deleted nodes are closed (KG-001), and their sources are scheduled for re-resolution.
7. **Resolve.** Run `ProjectResolver.resolve` on the affected set. TS uses `BuilderProgram`.
8. **Staleness** (PV-004, DOC-006). For claims and sections whose evidence references changed files or deleted nodes, set `freshness = 'stale'` as a new row version in N.
9. **Derived aggregates.** Recompute `depends_on` and `violates` only for the components that touch changed modules.
10. **Validate and publish.** Run RevisionValidator on the delta, then CAS-publish with `watermark = max(C.seq)` (SN-001/002).

**Fallback.** If the affected set exceeds a fraction of the repo (a [Proposal] config value calibrated by benchmarks), or a `tsconfig`/`package.json` changed, the job escalates to a project-scoped full re-resolution, still incremental at the file-extraction level.

## 8. Retrieval design: bounded query plans

Each query below takes `seq` (default head), `limit` (≤ server cap) and `signal`. Every recursive traversal carries an explicit depth bound and a row limit (KG-004). Cycle safety comes from `UNION` (not `UNION ALL`) on `(node, depth)`, plus a visited check in the application for path outputs.

### 8.1 Symbol search
- FTS5 `MATCH` on `name`/`qualified_name` (prefix and token), filtered by `kind`, `lang` and `path` glob.
- Join `node` with the visibility filter. Rank is FTS rank plus an exact-name bonus plus a bonus for exported symbols. Ordering is deterministic, with ties broken by `node_id`.
- Fallback: `name LIKE` on an indexed `name` column, for very short queries.

### 8.2 Concept search
FTS over concept titles, aliases and page text. Returns concepts with their `describes` pages and their `implements_concept` symbols (top-k, status-labeled).

### 8.3 Dependency query (outgoing / incoming, file or symbol)
```sql
WITH RECURSIVE dep(node_key, depth) AS (
  SELECT :startKey, 0
  UNION
  SELECT e.to_key, d.depth + 1 FROM dep d
  JOIN edge e ON e.from_key = d.node_key
   AND e.type IN ('imports','imports_symbol')      -- or calls / references_type, per request
   AND e.valid_from_seq <= :seq AND (e.valid_to_seq IS NULL OR e.valid_to_seq > :seq)
  WHERE d.depth < :maxDepth
)
SELECT * FROM dep LIMIT :limit + 1;                -- +1 to detect truncation
```
Incoming dependencies use `edge_in` (`to_key = d.node_key`). The final projection joins `node` with the visibility filter at `:seq`, so only node versions visible at that revision are returned.

### 8.4 Reference query
A single hop on `edge_in` with `type = 'references'` (plus `calls`), returning occurrence ranges from `attrs` and `ev_*` columns. Paginated by `(file path, start_line)`.

### 8.5 Architecture query
Reads `component` nodes plus `depends_on` and `violates` edges. These are aggregated and precomputed at publish (§7 step 9), so this is O(components) and never touches symbol edges.

### 8.6 Affected-symbol (impact) query
Input: changed paths or symbol IDs. Reverse closure over `references`, `calls`, `imports_symbol`, `extends`, `implements` and `references_type` using `edge_in`, up to `maxDepth` (default [Proposal]: 3). Each result reports:
- its depth;
- the path of edge types;
- the **weakest** status along the path, so an inferred edge anywhere makes the impact entry inferred.

### 8.7 Execution-flow query
Input: an entry symbol. It returns a DAG of up to `maxDepth` and `limit` nodes, built by traversing `calls` (and optionally `may_dispatch_to`) forward. Each step carries:
- the edge status;
- the call-site anchor;
- ordering by call-site position within the caller.

Flow-level summary: `{verifiedSteps, inferredSteps, unresolvedCalls}`. If `unresolvedCalls > 0`, the response states `completeness: 'partial'`. Flows are therefore evidence-qualified and never presented as complete when they are not (brief O3, "where sufficient evidence exists").

### 8.8 Neighbors (generic exploration)
One hop in or out over the requested types, grouped by type and capped per type (`perTypeLimit`). This feeds the UI relationship explorer.

## 9. Graph consistency checks (RevisionValidator)

| Check | Invariant | Query sketch |
|---|---|---|
| Dangling endpoints | KG-001 | Edges visible at N whose `from` or `to` is not visible at N must be 0 |
| Type signature | KG-002 | Join `relation_type`; node kinds ∈ allowed kinds |
| Structural backing | KG-003 | Symbol nodes without a visible file must be 0 |
| Duplicate IDs | SY-002 | `GROUP BY node_id HAVING count > 1` over visible rows |
| Span bounds | SY-003 | `end_line` ≤ file line count (stored per file) |
| Verified evidence | PV-001 | Verified claims without qualifying evidence must be 0 |
| Path membership | WS-001 | Structural records: `node.file_key` and `edge.ev_file_key` have a file version visible at N. Explicit evidence: `file_key` exists (historical versions are allowed; freshness is set by PV-004). |

## 10. Example knowledge graph

Fixture: a small TS workspace with `src/auth/session.ts` (`SessionStore.refresh`), `src/auth/token-client.ts` (`TokenClient.fetchToken`), `src/api/http.ts` (`HttpClient.send`), and a curated page `docs/wiki/concepts/session-refresh.md`.

```mermaid
flowchart LR
  F1["file:src/auth/session.ts"] -- contains V --> S1["ts:src/auth/session.ts#SessionStore(class)"]
  S1 -- contains V --> S2["ts:src/auth/session.ts#SessionStore.refresh(method)"]
  F2["file:src/auth/token-client.ts"] -- contains V --> S3["ts:src/auth/token-client.ts#TokenClient.fetchToken(method)"]
  S2 -- "calls V (compiler)" --> S3
  S3 -- "calls V (compiler)" --> S4["ts:src/api/http.ts#HttpClient.send(method)"]
  S2 -- "calls ? (dynamic)" --> U1["unres:ts:src/auth/session.ts#a91f"]
  C1(["concept:session-refresh"])
  S2 -- "implements_concept U (page front matter)" --> C1
  S3 -- "implements_concept I (llm, 2 evidence)" --> C1
  P1["page:concepts/session-refresh"] -- "describes U" --> C1
  P1 -- "mentions V" --> S2
  CMP1["comp:auth"] -- "depends_on V" --> CMP2["comp:api"]
```

JSON export fragment (`cie export --format json`; deterministic ordering):

```json
{
  "apiVersion": "1.0",
  "revision": { "seq": 42, "watermark": 1187, "freshness": "current" },
  "nodes": [
    { "id": "ts:src/auth/session.ts#SessionStore.refresh(method)", "kind": "symbol", "symbolKind": "method",
      "location": { "path": "src/auth/session.ts", "range": { "startLine": 17, "startCol": 2, "endLine": 31, "endCol": 3 } },
      "spanHash": "sha256:5c1e…", "producer": "lang-ts@0.1.0+typescript@<pinned>", "fidelity": "L3" },
    { "id": "concept:session-refresh", "kind": "concept", "title": "Session refresh", "owner": "user" }
  ],
  "edges": [
    { "type": "calls", "from": "ts:src/auth/session.ts#SessionStore.refresh(method)",
      "to": "ts:src/auth/token-client.ts#TokenClient.fetchToken(method)", "status": "verified", "precision": "exact",
      "evidence": [{ "kind": "compiler", "path": "src/auth/session.ts",
        "range": { "startLine": 22, "startCol": 10, "endLine": 22, "endCol": 41 }, "contentHash": "sha256:9ab0…", "seq": 42 }] },
    { "type": "implements_concept", "from": "ts:src/auth/token-client.ts#TokenClient.fetchToken(method)",
      "to": "concept:session-refresh", "status": "inferred", "freshness": "current", "claimId": "claim:7f3c…",
      "evidence": [
        { "kind": "llm", "artifact": "llm:response:sha256:e21d…", "producer": "ollama:qwen2.5-coder@<digest>", "seq": 42 },
        { "kind": "compiler", "path": "src/auth/session.ts", "range": { "startLine": 22, "startCol": 10, "endLine": 22, "endCol": 41 }, "seq": 42 } ] },
    { "type": "calls", "from": "ts:src/auth/session.ts#SessionStore.refresh(method)",
      "to": "unres:ts:src/auth/session.ts#a91f", "status": "unknown",
      "attrs": { "raw": "this.hooks[event]()" } }
  ]
}
```

## 11. SQLite vs. a graph database: summary

See ADR-0008. SQLite satisfies the MVP query set (§8), because every query is either a one-hop indexed lookup or a depth-bounded recursive CTE. Graph-native features (variable-length pattern matching, centrality) are not MVP requirements. Kùzu is archived (E-13) and duckpgq is a research extension (E-14). The revisit trigger is benchmark evidence (FF-PRF-003) on the medium tier.
