import type { ContentHash } from './content-hash.js';

/** Injected hashing port. The Node adapter uses node:crypto, so the core never imports it. */
export interface Hasher {
  /** SHA-256 of raw bytes (file contents). */
  sha256(data: Uint8Array): ContentHash;
  /**
   * SHA-256 of the UTF-8 encoding of `text`, used for canonical serializations (manifest hash, span
   * hash). It lives on the port because the core compiles without TextEncoder (ES2022 lib only).
   * Lone surrogates are not valid input; callers guarantee well-formed strings.
   */
  sha256Text(text: string): ContentHash;
}
