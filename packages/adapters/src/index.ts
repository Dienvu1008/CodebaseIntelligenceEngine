/**
 * @cie/adapters: implementations of @cie/core ports.
 *
 * Each adapter lives in its own subfolder (sqlite, fs, config, ...) with a third-party allow-list per
 * subfolder (DEPENDENCY_RULES §4). Only this entry point is exported.
 */
export { defaultUserConfigDir, FileConfigSource, USER_CONFIG_FILE, WORKSPACE_CONFIG_FILE } from './config/file-config-source.js';
export { GuardedFileSystem } from './fs/guarded-file-system.js';
export { NodeHasher, SystemClock } from './fs/system.js';
export { JsonWorkspaceRepository, newWorkspaceId } from './fs/workspace-identity.js';
export { WriteConfinement, type WriteConfinementOptions, type WritePurpose } from './fs/write-confinement.js';
export { SqliteIndexStore, visibleAt } from './sqlite/index-store.js';
export { SqliteLeaseManager } from './sqlite/lease.js';
export { openIndexStore, type OpenedIndexStore, type OpenIndexStoreOptions, type StateWriteGate } from './sqlite/open.js';
export { INDEX_SCHEMA_VERSION, type OpenOutcome } from './sqlite/schema.js';
export { migrate, STATE_MIGRATIONS, STATE_SCHEMA_VERSION, validateChain, type Migration, type MigrationOutcome } from './sqlite/state-migrations.js';
export { openStateStore, SqliteJobRepository, type OpenedStateStore, type OpenStateStoreOptions } from './sqlite/state-store.js';
