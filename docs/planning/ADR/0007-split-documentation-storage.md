# ADR-0007: Split Documentation Storage (Repo vs `.cie/`)

- **Status:** Accepted
- **Date:** 2026-10-31
- **Related:** DEC-04, FR-040..046, [DOCUMENTATION_MODEL](../DOCUMENTATION_MODEL.md), ADR-0008

## Context

Documentation has two populations with very different properties:

| Population | Shared? | Reviewable? | Rebuildable? | Conflict-prone? |
|---|---|---|---|---|
| Curated pages written or edited by people | Must be shared with the team | Yes (PR review) | No | Low |
| Generated drafts (templates and LLM), index, caches | Optional | Not needed | Yes (at compute or LLM cost) | High, since generators rewrite often |

## Options considered

| Option | Pros | Cons |
|---|---|---|
| A. Everything committed to the repo | Single source; git history | Generator churn in PRs; merge conflicts; LLM-written prose committed without review |
| B. Everything local in `.cie/` | No conflicts | Curated knowledge is not shared; lost if `.cie/` is deleted |
| **C. Split** | Shared curated knowledge; disposable generated artifacts | Two locations to explain; needs a publish flow |

## Decision

**Option C.**

| Location | Contents | Committed? |
|---|---|---|
| `docs/wiki/` (configurable `wiki.dir`) | Curated pages, user-declared concepts and relations (front matter), and published generated sections when publishing is enabled | Yes |
| `.cie/index.db` | Derived index (rebuildable) | No (git-ignored) |
| `.cie/state.db` | Local non-derivable state: conflict records, doc write log, LLM response cache, job history | No |
| `.cie/wiki/` | Generated draft pages | No |
| `.cie/conflicts/` | Conflict proposals | No |
| User config dir (outside the workspace) | Consent, LLM provider and endpoint, secrets references | Never in the workspace |

- **Publishing** (`wiki.publishGenerated: true`, opt-in) copies generated pages or sections into `wiki.dir`, with ownership markers.
- **Ownership** comes from markers inside the file (DOC-001). Location alone never decides ownership.

## Consequences

- Repo Markdown plus source is the **only** non-rebuildable shared truth. This holds the NFR-020 rebuild guarantee.
- `cie init` offers to add `.cie/` to `.gitignore`. It only writes after explicit confirmation or `--update-gitignore`, which is a registered SEC-002 write exception; otherwise it prints instructions.

## Revisit trigger

Teams ask for shared generated drafts without publishing them. A possible answer is committed `.cie/wiki` with LFS; this is not planned.
