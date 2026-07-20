import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthedRequest } from '../../auth/jwt-auth.guard';

/**
 * The authoritative hospital (tenant) scope for a staff/doctor request — always
 * the token's hospitalId, never a request parameter. A staff token without a
 * hospital scope is malformed for any tenant-scoped surface (403, fail closed).
 */
export function tenantHospitalId(req: AuthedRequest): string {
  const hid = req.user?.hospitalId;
  if (!hid) throw new ForbiddenException('token missing hospital scope');
  return hid;
}

/**
 * Defense-in-depth guard: asserts the authenticated principal carries a
 * hospitalId before any tenant-scoped handler runs. Belt-and-braces alongside
 * the per-query TenantService filters — a token minted before the multi-tenant
 * migration (no hospitalId) is rejected outright rather than silently
 * wildcard-matching. Runs AFTER JwtAuthGuard (which sets request.user).
 */
@Injectable()
export class TenantScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!req.user?.hospitalId) {
      throw new ForbiddenException('token missing hospital scope');
    }
    return true;
  }
}
