# Deliberate architecture violations

Each file here breaks exactly one fitness rule on purpose. `tests/fitness/depcruise-rules.spec.ts` runs dependency-cruiser over this folder as a mini repository (its `packages/` layout mirrors the real one) and expects **every** rule in `.dependency-cruiser.cjs` to fire at least once. This proves that no rule is vacuous.

These files are excluded from type checking, linting and the real `npm run depcruise`. Imports of packages that are not installed (`vscode`, `react`, …) are intentional, because depcruise reports unresolved modules by name.

| File | Rule it violates |
|---|---|
| `packages/adapters/src/cyc/a.ts` ↔ `b.ts` | FF-DEP-001 |
| `packages/core/src/workspace/domain/uses-npm.ts` | FF-DEP-002 |
| `packages/core/src/workspace/domain/uses-node-builtin.ts` | FF-DEP-002b |
| `packages/runtime/src/uses-vscode.ts` | FF-DEP-003 |
| `packages/runtime/src/uses-codeforge.ts` | FF-DEP-004 |
| `packages/runtime/src/uses-react.ts` | FF-DEP-005 |
| `packages/protocol/src/uses-npm.ts` | FF-DEP-006 |
| `packages/runtime/src/uses-child-process.ts` | FF-DEP-007 |
| `packages/runtime/src/uses-sqlite.ts` | FF-DEP-008 |
| `packages/runtime/src/uses-tree-sitter.ts` | FF-DEP-008b |
| `packages/runtime/src/uses-typescript.ts` | FF-DEP-008c |
| `packages/runtime/src/uses-openai.ts` | FF-DEP-008d |
| `packages/runtime/src/uses-mcp.ts` | FF-DEP-008e |
| `packages/core/src/knowledge/application/deep-import.ts` | FF-BND-001 |
| `packages/core/src/shared-kernel/leak.ts` | FF-BND-001b |
| `packages/core/src/workspace/domain/uses-application.ts` | FF-BND-002 |
| `packages/core/src/workspace/application/uses-sync.ts` | FF-BND-002b |
| `packages/core/src/workspace/application/uses-knowledge.ts` | FF-BND-002c |
| `packages/core/src/synchronization/application/uses-query.ts` | FF-BND-002d |
| `packages/adapters/src/llm-ollama/verify.ts` | FF-BND-005 |
