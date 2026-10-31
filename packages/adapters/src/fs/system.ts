// System implementations of the shared-kernel Hasher and Clock ports (SYSTEM_ARCHITECTURE §7).
import { createHash } from 'node:crypto';
import type { Clock, ContentHash, Hasher } from '@cie/core';

const toContentHash = (hex: string): ContentHash => `sha256:${hex}` as ContentHash;

export class NodeHasher implements Hasher {
  sha256(data: Uint8Array): ContentHash {
    return toContentHash(createHash('sha256').update(data).digest('hex'));
  }

  sha256Text(text: string): ContentHash {
    return toContentHash(createHash('sha256').update(text, 'utf8').digest('hex'));
  }
}

export class SystemClock implements Clock {
  nowMs(): number {
    return Date.now();
  }
}
