import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthTokenService, SessionClaims } from './auth-token.service';

/** Minimal request shape the auth guards touch (avoids an express type dep). */
export interface AuthedRequest {
  headers: { authorization?: string };
  user?: SessionClaims;
}

/**
 * Authenticates a bearer token and attaches claims to the request.
 * Missing/invalid/expired token -> 401. Authorization (role) is RolesGuard's job.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly tokens: AuthTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    req.user = this.tokens.verify(header.slice(7)); // throws -> 401
    return true;
  }
}
