import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts', 'packages/*/test/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/fitness/fixtures/**'],
    environment: 'node',
    // Deterministic ordering: tests must not depend on order, and runs must be reproducible.
    sequence: { shuffle: false },
    testTimeout: 30_000,
  },
});
