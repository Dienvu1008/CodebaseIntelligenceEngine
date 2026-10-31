// synchronization receives verification as an injected dependency; it never imports it (FF-BND-005b).
import { ClaimVerifier } from '../../knowledge/domain/verification/index.ts';
export const x = ClaimVerifier;
