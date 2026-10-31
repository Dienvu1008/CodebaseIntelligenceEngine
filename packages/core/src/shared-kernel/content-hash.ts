import type { DomainError } from './domain-error.js';
import { domainError } from './domain-error.js';
import type { Brand } from './ids.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

/** Content hash in the form `sha256:<64 lowercase hex chars>`. */
export type ContentHash = Brand<string, 'ContentHash'>;

const CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

export function parseContentHash(value: string): Result<ContentHash, DomainError> {
  if (!CONTENT_HASH.test(value)) {
    return err(domainError('INVALID_CONTENT_HASH', 'content hash must match sha256:<64 lowercase hex>', { value }));
  }
  return ok(value as ContentHash);
}
