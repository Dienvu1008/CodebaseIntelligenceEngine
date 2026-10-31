/** Injected time source, so core logic stays deterministic in tests. */
export interface Clock {
  /** Milliseconds since the Unix epoch. Informational only: ordering always uses sequence numbers. */
  nowMs(): number;
}
