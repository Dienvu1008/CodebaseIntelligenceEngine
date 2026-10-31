/**
 * @cie/adapters: implementations of @cie/core ports.
 *
 * Each adapter lives in its own subfolder (sqlite, fs, treesitter, ...) with a third-party allow-list per
 * subfolder (DEPENDENCY_RULES §4). Only this entry point is exported.
 */
export { GuardedFileSystem } from './fs/guarded-file-system.js';
export { NodeHasher, SystemClock } from './fs/system.js';
export { SqliteIndexStore, visibleAt } from './sqlite/index-store.js';
export { SqliteLeaseManager } from './sqlite/lease.js';
export { openIndexStore, type OpenedIndexStore, type OpenIndexStoreOptions, type StateWriteGate } from './sqlite/open.js';
export { INDEX_SCHEMA_VERSION, type OpenOutcome } from './sqlite/schema.js';
export { WriteConfinement, type WriteConfinementOptions, type WritePurpose } from './fs/write-confinement.js';
