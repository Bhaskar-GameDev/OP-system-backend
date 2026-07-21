import { timingSafeEqual } from 'node:crypto';
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Server-to-server auth for the voice agent. The `/voice/*` API is not called by
 * a logged-in user — it is called by the trusted voice agent process, which
 * presents a shared secret in the `x-voice-secret` header.
 *
 * Fail closed: if no `VOICE_INTERNAL_SECRET` is configured the API is unusable (401), so
 * the endpoints are never silently open. Constant-time compare avoids leaking the
 * secret via timing.
 */
@Injectable()
export class VoiceSecretGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const configured = this.config.get<string>('VOICE_INTERNAL_SECRET');
    if (!configured) {
      throw new UnauthorizedException('voice API not configured');
    }
    const req = context.switchToHttp().getRequest<{
      headers: { 'x-voice-secret'?: string };
    }>();
    const presented = req.headers['x-voice-secret'] ?? '';

    const a = Buffer.from(presented);
    const b = Buffer.from(configured);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new UnauthorizedException('invalid voice secret');
    }
    return true;
  }
}
