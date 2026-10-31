# ADR-0009: Local-First LLM Policy

- **Status:** Accepted
- **Date:** 2026-10-31
- **Related:** DEC-05, FR-060..066, AI-001..004, SEC-001, SEC-003, [SECURITY_AND_RELIABILITY](../SECURITY_AND_RELIABILITY.md)

## Context

- Source code is sensitive. Local-first and offline-capable operation is a hard requirement (NFR-015).
- [Fact] CodeForge defaults to Ollama on `http://localhost:11434` (E-31). This is precedent for local-first defaults in the same developer ecosystem.
- O6 requires AI assistance, while AI output must never be authoritative.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| Ollama only | Maximum privacy | Excludes users who want stronger cloud models |
| **Local default, cloud opt-in with consent + redaction** | Privacy by default; flexibility | Consent and redaction must be engineered and tested |
| No default provider | Neutral | Bad first-run experience; LLM features unusable until configured |

## Decision

1. **CIE defines its own `LlmProvider` port in `@cie/core`.** No SDK types cross the port.
   ```ts
   interface LlmProvider {
     readonly id: string;
     readonly locality: 'local' | 'remote';
     complete(req: LlmRequest, signal: CancellationSignal): Promise<LlmResult>;
   }
   ```
2. **Adapters (in `@cie/adapters`):**

   | Adapter | Notes |
   |---|---|
   | `llm-none` | Default when nothing is configured |
   | `llm-ollama` | Default when Ollama is reachable on localhost |
   | `llm-openai-compatible` | `locality: 'remote'` unless the endpoint resolves to loopback |

3. **Remote use requires all of the following:**
   - Consent recorded in the **user** config directory, keyed by workspace ID plus root path hash. It is never read from the workspace (NFR-032).
   - Redaction through `SecretRedactor`.
   - Exclusion of secret-pattern files.

   The composition root enforces this by wrapping every remote provider in a `GuardedProvider`. No code path can obtain an unguarded remote provider (SEC-003).
4. **LLM output enters only as `inferred` claims or prose sections** (AI-001..003).
5. **Everything except prose generation works with `llm-none`** (AI-004), and CI runs the full suite with `llm-none`.

## Consequences

- Prose quality depends on local model capability, so benchmark intelligence-quality metrics are recorded per model.
- LLM responses are cached in `state.db` by input hash for determinism and cost control.

## Revisit trigger

Revisit when a provider-neutral standard for local models emerges, or when the consent model proves too strict in user research.
