// @cie/core public surface. This file re-exports only the shared kernel and each context's public.ts
// (BOUNDED_CONTEXTS §6). Deep imports are blocked by the package exports map (FF-BND-007).
export * from './shared-kernel/index.js';
export type * from './workspace/public.js';
export type * from './synchronization/public.js';
export * from './code-intelligence/public.js';
export * from './knowledge/public.js';
export * from './documentation/public.js';
export * from './query/public.js';
