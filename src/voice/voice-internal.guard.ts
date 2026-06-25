import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Minimal request shape this guard touches (avoids an express type dep). */
interface HeaderedRequest {
  headers: Record<string, string | string[] | undefined>;
}

/**
 * Guards the internal Voice API. The standalone voice-agent process is the ONLY
 * caller — it is not a public/patient surface, so instead of JWT it presents a
 * shared secret in the `x-voice-secret` header. The secret is compared in
 * constant time to avoid leaking length/prefix via timing.
 *
 * If VOICE_INTERNAL_SECRET is unset the API is hard-closed (deny all) rather
 * than open — fail safe, never fail open.
 */
@Injectable()
export class VoiceInternalGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('VOICE_INTERNAL_SECRET');
    if (!expected) {
      throw new UnauthorizedException('voice API disabled (no secret configured)');
    }
    const req = context.switchToHttp().getRequest<HeaderedRequest>();
    const raw = req.headers['x-voice-secret'];
    const provided = (Array.isArray(raw) ? raw[0] : raw) ?? '';
    if (!timingSafeEqual(provided, expected)) {
      throw new UnauthorizedException('invalid voice secret');
    }
    return true;
  }
}

/** Length-independent constant-time string compare. */
function timingSafeEqual(a: string, b: string): boolean {
  // XOR length into the accumulator so unequal lengths still run the full loop.
  let mismatch = a.length === b.length ? 0 : 1;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    mismatch |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return mismatch === 0;
}
