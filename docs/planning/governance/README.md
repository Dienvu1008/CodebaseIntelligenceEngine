# Governance files have moved

In Phase 00 (checklist item P00-08) the machine-readable governance files moved to the repository root:

- [`/governance/invariants.yaml`](../../../governance/invariants.yaml), the invariant register
- [`/governance/invariants.schema.json`](../../../governance/invariants.schema.json), its JSON Schema
- [`/governance/fitness.yaml`](../../../governance/fitness.yaml), the fitness function register
- [`/governance/shared-kernel.allowlist`](../../../governance/shared-kernel.allowlist), the files permitted in `shared-kernel`
- [`/governance/phase_00_checklist.yaml`](../../../governance/phase_00_checklist.yaml), plus one checklist per later phase

`node scripts/check-governance.mjs` validates all of them.
