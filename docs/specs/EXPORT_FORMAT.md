# Export format `cie-export/2`: canonicalization rules

> Status: Accepted. `cie-export/1` (Phase 01, P01-14) was extended to `/2` in Phase 02 (P02-11) by the code graph. Enforced by `tests/cross-platform/export-golden.spec.ts` (required CI) for every golden fixture (`tests/helpers/golden.ts`). Related: WS-002, WS-004, NFR-023, FF-DAT-006

`cie dev export` writes a snapshot of the published head revision. For the **same tree, the same configuration and the same publish history**, the output is **byte-identical** on every OS, machine, locale and run. Every rule below is a hard rule. Changing any of them requires bumping `format`.

## 1. Encoding

| Rule | Detail |
|---|---|
| E1 | UTF-8, **no BOM**. |
| E2 | Every path is NFC by construction (PathCanonicalizer). Strings taken from source code (symbol names, qualified names, docs, raw import specifiers) are exported **exactly as written**, without normalization (ADR-0014: JavaScript and Python treat differently normalized identifiers as distinct). The output is still byte-stable, because it depends only on the file bytes. |
| E3 | No unpaired surrogates. Paths cannot contain them (WS-002). |

## 2. Line endings and layout

| Rule | Detail |
|---|---|
| L1 | Line separator is LF (`\n`). The output contains **no CR byte** at all; CR inside a string value would be JSON-escaped as `\r`. |
| L2 | The document ends with exactly one LF. |
| L3 | JSON with two-space indentation, exactly as produced by `JSON.stringify(value, null, 2)`. |

## 3. Structure and key order

Keys appear in this declared order, never alphabetically and never in insertion order chosen at runtime:

```
{ format, revision, manifestHash, files[], structure[], nodes[], edges[] }
files[i]:      indexed → { path, status, hash, size, language }
               skipped → { path, status, reason, size }
structure[i]:  { id, kind, name, ecosystem, file }
nodes[i]:      { id, kind, name, file, language, symbol, producer }
  symbol:      null unless kind = symbol → { qualifiedName, kind, range, spanHash, bodyFingerprint, exported, defaultExport, doc }
  range:       { startLine, startCol, endLine, endCol }       (0-based lines, UTF-16 columns, end-exclusive)
  producer:    { adapterId, adapterVersion, toolVersion, fidelity }
edges[i]:      { type, from, to, site, status, precision, producer, evidence, attrs }
  evidence:    null or { kind, path, range, contentHash }
  attrs:       object whose keys are sorted in UTF-16 code-unit order (values: string, boolean or null)
```

`nodes` holds the code graph only (module, symbol, external, unresolved). Structural nodes stay in `structure`. `format` is `cie-export/2`.

| Rule | Detail |
|---|---|
| S1 | Absent values are `null`, never omitted (`language`, `ecosystem`, `file`, `symbol`, `doc`, `precision`, `evidence`). |
| S2 | Numbers are non-negative integers. No floats, no exponents. |
| S3 | `revision` is the head seq. It depends on the publish history, not on the machine: compare exports produced by the same number of publishes (golden tests use a fresh state dir, so it is 1). |
| S4 | `manifestHash` is SHA-256 over the `cie-manifest/1` serialization (WS-004). |

## 4. Paths

| Rule | Detail |
|---|---|
| P1 | Every path is a CanonicalPath: workspace-relative, `/`-separated, no `.`/`..`/empty segments, no drive or UNC prefix (WS-002). |
| P2 | Case is preserved. Two paths differing only in case are different paths. |

## 5. Ordering

| Rule | Detail |
|---|---|
| O1 | `files` is sorted by `path` in **UTF-16 code-unit** order. |
| O2 | `structure` and `nodes` are sorted by `id` in UTF-16 code-unit order. |
| O4 | `edges` are sorted by `(type, from, to, site)`, comparing field by field in UTF-16 code-unit order. |
| O3 | Locale collation (`localeCompare`, ICU) is never used. |

## 6. Forbidden content

The export must contain none of the following:

| Rule | Forbidden | Why |
|---|---|---|
| F1 | Absolute paths: the workspace root, the state dir, the home dir, temp dirs | Machine-specific |
| F2 | Timestamps of any kind (creation, publish, mtime) | Run-specific |
| F3 | The workspace id, lease holder ids, job ids, nonces | Random or per-run |
| F4 | Host names, user names, PIDs, OS or Node versions | Machine-specific |
| F5 | File mtimes or inode numbers | Filesystem-specific |

## 7. Inputs that must be identical for byte-identical output

These are preconditions, not rules of the export. CIE hashes the bytes it reads:

- **Checkout line endings.** Use `core.autocrlf=false` for fixture clones. CIE's own repository enforces `eol=lf` through `.gitattributes`, and marks deliberate CRLF fixtures `-text`.
- **The same configuration:** `cie.config.json` plus CIE defaults.
- **Symlinks** are reported as entries with size 0, so their target paths never leak in. Windows checkouts without symlink support produce regular files, so cross-OS fixtures contain no symlinks.
