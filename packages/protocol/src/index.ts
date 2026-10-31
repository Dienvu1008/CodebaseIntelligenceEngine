/**
 * @cie/protocol: the public wire contract (PUBLIC_API_CONTRACT.md).
 *
 * Phase 00 ships the package boundary only. The DTOs, method catalog and error codes arrive in Phase 06
 * (v1-pre) and are frozen as v1.0 in Phase 09. This package must stay dependency-free (FF-DEP-006).
 */
export const PROTOCOL_PACKAGE = '@cie/protocol' as const;
