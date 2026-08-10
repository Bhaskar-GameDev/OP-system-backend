import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthTokenService, SessionClaims } from './auth-token.service';
import { SessionRevocationService } from './session-revocation.service';

/** Minimal request shape the auth guards touch (avoids an express type dep). */
export interface AuthedRequest {
  headers: { authorization?: string };
  user?: SessionClaims;
}

/**
 * Authenticates a bearer token and attaches claims to the request.
 * Missing/invalid/expired/revoked token -> 401. Authorization (role) is
 * RolesGuard's job.
 *
 * The revocation check costs one Redis read per authenticated request. That is
 * the price of the token being withdrawable at all: signature and expiry alone
 * cannot express "this session ended", and the alternative — waiting up to an
 * hour for a leaked staff token to lapse — is the finding this closes.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly tokens: AuthTokenService,
    private readonly revocation: SessionRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('missing bearer token');
    }
    const claims = this.tokens.verify(header.slice(7)); // throws -> 401
    await this.revocation.assertActive(claims); // throws -> 401
    req.user = claims;
    return true;
  }
}
