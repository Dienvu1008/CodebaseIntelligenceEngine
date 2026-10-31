import type { ContentHash } from './content-hash.js';

/** Injected hashing port. The Node adapter uses node:crypto, so the core never imports it. */
export interface Hasher {
  sha256(data: Uint8Array): ContentHash;
}
