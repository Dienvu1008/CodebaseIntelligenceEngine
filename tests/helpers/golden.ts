// The golden fixtures (P02-12): committed workspaces under fixtures/<name>, each with a committed, reviewed
// export at fixtures/<name>.export.json. Every fitness and golden test iterates this one list.
export const GOLDEN_FIXTURES = ['xplat-basic', 'ts-basic', 'ts-monorepo', 'js-mixed', 'py-basic', 'py-src-layout', 'edge-cases', 'ts-relations', 'py-relations'] as const;
export type GoldenFixture = (typeof GOLDEN_FIXTURES)[number];
