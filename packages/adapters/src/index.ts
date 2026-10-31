/**
 * @cie/adapters: implementations of @cie/core ports.
 *
 * Phase 00 ships the package boundary only (NFR-044). Each adapter lives in its own subfolder
 * (sqlite, fs, treesitter, ...), with a third-party allow-list per subfolder (DEPENDENCY_RULES §4).
 */
export const ADAPTERS_PACKAGE = '@cie/adapters' as const;
