// The verification capability (DEPENDENCY_RULES C8). Published as the `@cie/core/verification` subpath, never
// from the main `@cie/core` entry, so code that imports `@cie/core` cannot verify claims. Importable only from
// the knowledge context and the runtime composition root (FF-BND-005, FF-BND-005b).
export type { VerifiableClaim } from './claim-verifier.js';
export { ClaimVerifier } from './claim-verifier.js';
