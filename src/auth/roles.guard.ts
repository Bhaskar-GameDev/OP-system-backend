import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from './auth-token.service';
import { AuthedRequest } from './jwt-auth.guard';
import { ROLES_KEY } from './roles.decorator';

/**
 * Authorizes by role. Runs after JwtAuthGuard (which sets request.user).
 * Endpoint without @Roles is allowed for any authenticated user; a role
 * mismatch returns 403.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[] | undefined>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!required || required.length === 0) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const role = req.user?.role;
    if (!role || !required.includes(role)) {
      throw new ForbiddenException('insufficient role');
    }
    return true;
  }
}
