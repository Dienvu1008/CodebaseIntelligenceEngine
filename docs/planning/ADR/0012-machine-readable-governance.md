# ADR-0012: Machine-Readable Governance from Day One

- **Status:** Accepted
- **Date:** 2026-10-31
- **Related:** DEC-07, NFR-040..044, [DOMAIN_INVARIANTS](../DOMAIN_INVARIANTS.md), [ARCHITECTURE_FITNESS](../ARCHITECTURE_FITNESS.md), [governance/](../governance/)

## Context

- [Fact] CodeForge keeps prose invariants and a YAML+JSON-Schema mirror in sync. CI fails when a CRITICAL invariant lacks a test (E-21). The approach has worked through more than 12 phases of that project.
- Prose-only rules erode. CIE's objective O8 requires governance that a machine can execute.

## Decision

1. `governance/invariants.yaml` (validated by `invariants.schema.json`, JSON Schema draft-07) mirrors [DOMAIN_INVARIANTS.md](../DOMAIN_INVARIANTS.md) one to one.
   - Fields: `id, statement, owner, kind (hard|recommendation), enforcement[], violation_class, test, phase, severity, status`.
   - ID pattern: `^[A-Z]{2,3}-[0-9]{3}$`. The extra `owner` and `kind` fields extend CodeForge's format.
2. `governance/phase_NN_checklist.yaml` exists per phase and is machine-checked.
3. **Phase 00 delivers `scripts/check-governance.mjs`**, which:
   - validates the YAML against its schema;
   - fails if any `ACTIVE` CRITICAL or HIGH invariant of a completed phase (`phase < current_phase`, from `governance/phase.yaml` or `CIE_PHASE`) has a missing test file. Invariants of the phase in progress produce warnings (C-11);
   - fails if an ID that existed in the base branch has disappeared, since retirement requires `DEPRECATED`.
4. **Gate.** Phase N is not complete while any CRITICAL invariant with `phase ≤ N` is failing or missing.
5. **Fitness functions** are listed in `governance/fitness.yaml` (Phase 00 deliverable). This package specifies them in ARCHITECTURE_FITNESS.

## Consequences

- The files started in `docs/planning/governance/`. Phase 00 moved them to the repo-root `governance/` and left a pointer README behind (checklist item P00-08).
- There is a small up-front cost and a large protection against drift.

## Evidence

E-21.
