import type { Brand } from './ids.js';

/**
 * Workspace-relative, '/'-separated, NFC-normalized path with no '.', '..' or empty segments,
 * no leading '/' and no drive or UNC prefix (WS-002).
 *
 * Only the type lives in the shared kernel. The constructor (PathCanonicalizer) belongs to the
 * workspace context and arrives in Phase 01.
 */
export type CanonicalPath = Brand<string, 'CanonicalPath'>;
