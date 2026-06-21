import { ForbiddenException } from '@nestjs/common';
import { AuthedRequest } from '../auth/jwt-auth.guard';

/**
 * The authoritative clinic scope for an admin request — always the token's
 * clinicId, never a request parameter. An admin token without a clinic scope is
 * malformed for this surface (403).
 */
export function adminClinicId(req: AuthedRequest): string {
  const cid = req.user?.clinicId;
  if (!cid) throw new ForbiddenException('admin token missing clinic scope');
  return cid;
}

/**
 * If the request body/query carries a clinicId at all, it may ONLY confirm the
 * token's scope — a mismatch is 403, never a scope switch. Bodies that omit
 * clinicId are fine (scope comes from the token regardless).
 */
export function assertClinicMatch(tokenClinicId: string, supplied?: string): void {
  if (supplied !== undefined && supplied !== tokenClinicId) {
    throw new ForbiddenException('clinicId does not match your clinic');
  }
}
