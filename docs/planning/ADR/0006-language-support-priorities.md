# ADR-0006: Language Support: TS/JS Deep, Python via Adapter, Dart Deferred

- **Status:** Accepted
- **Date:** 2026-10-31
- **Related:** DEC-03, FR-020..028, [CODE_INTELLIGENCE_STRATEGY](../CODE_INTELLIGENCE_STRATEGY.md), ADR-0010, ADR-0016

## Context

- TS/JS is the primary language of both the developer and CodeForge-v2. The TypeScript compiler gives exact semantic information for it.
- Python is widely used. A Python adapter proves early that the `LanguageAdapter` abstraction does not assume TypeScript semantics.
- [Fact] Tree-sitter grammars that ship WASM exist for TypeScript, TSX (E-03) and Python (E-04). SCIP indexers exist for TS, Python and Dart (E-15).
- [Fact] Exact Python semantics (scip-python, which is Pyright) need Python 3.10+ and pip environment discovery (E-17). That depends on the user's environment, so it is unsuitable as a mandatory MVP dependency.

## Options considered

| Option | Pros | Cons |
|---|---|---|
| TS/JS only | Fastest | Abstraction untested; TS assumptions leak |
| **TS/JS deep + Python at L1/L2** | Proves the abstraction with honest fidelity labels | Two grammars and two query sets to maintain |
| TS/JS + Python + Dart | Matches the CodeForge grammars | More maintenance before value is proven |

## Decision

| Language | MVP capability | Mechanism |
|---|---|---|
| TS/JS | Symbols L3, imports L3, references, calls and type relations L3 | tree-sitter for outline, spans and fingerprints; TypeScript compiler API for semantics (ADR-0016) |
| Python | Symbols L1, imports L2, references and calls L2 (emitted as `inferred`), class bases L2 | tree-sitter only, plus deterministic heuristic resolution |
| Dart | [DEF] Planned | Same port. Candidates: tree-sitter grammar plus `scip-dart` import (E-15) |

The fidelity of every result is exposed through the API (FR-025).

## Consequences

- The capability matrix becomes part of the public contract, so Python users see "heuristic" labels.
- Optional exact Python references via SCIP are covered by ADR-0011 (post-MVP).

## Evidence

E-03, E-04, E-15, E-17.

## Revisit trigger

- **Dart:** schedule after Phase 08 when there is user demand, or when CodeForge Dart workloads need it.
- **Python fidelity:** raise if heuristic precision on the benchmark ground truth turns out too low (see BENCHMARK_STRATEGY §5).
