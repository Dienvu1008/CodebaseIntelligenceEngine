import type { DomainError } from './domain-error.js';
import { domainError } from './domain-error.js';
import type { Result } from './result.js';
import { err, ok } from './result.js';

declare const brand: unique symbol;

/**
 * Nominal ("branded") type. A raw `string` or `number` is not assignable to a branded type, so IDs
 * can only be produced by their owning constructor (e.g. SymbolId by SymbolIdentity, SY-001).
 */
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type WorkspaceId = Brand<string, 'WorkspaceId'>;
export type SymbolId = Brand<string, 'SymbolId'>;
export type NodeId = Brand<string, 'NodeId'>;
export type ClaimId = Brand<string, 'ClaimId'>;
export type EvidenceId = Brand<string, 'EvidenceId'>;
export type PageId = Brand<string, 'PageId'>;
export type SectionId = Brand<string, 'SectionId'>;
export type JobId = Brand<string, 'JobId'>;

/** Monotonic index revision sequence number (ADR-0015). */
export type RevisionSeq = Brand<number, 'RevisionSeq'>;

/** RevisionSeq must be a non-negative safe integer. */
export function revisionSeq(value: number): Result<RevisionSeq, DomainError> {
  if (!Number.isSafeInteger(value) || value < 0) {
    return err(domainError('INVALID_REVISION_SEQ', 'revision seq must be a non-negative safe integer', { value }));
  }
  return ok(value as RevisionSeq);
}
