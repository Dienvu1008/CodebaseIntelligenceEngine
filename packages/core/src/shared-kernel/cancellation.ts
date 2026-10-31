/**
 * Minimal structural cancellation interface (contradiction log C-01).
 *
 * The core compiles against the ES2022 lib only, without Node or DOM types (FF-DEP-002), so it cannot
 * name `AbortSignal`. A real `AbortSignal` satisfies this interface structurally, which
 * tests/fitness/type-level.spec.ts checks.
 */
export interface CancellationSignal {
  readonly aborted: boolean;
  readonly reason?: unknown;
  addEventListener(type: 'abort', listener: () => void, options?: { readonly once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}
