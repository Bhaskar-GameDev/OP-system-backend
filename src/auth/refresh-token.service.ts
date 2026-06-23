import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Opaque, rotating refresh tokens backed by Redis.
 *
 * The raw token is a random 256-bit string handed to the client; only its
 * SHA-256 hash is stored server-side (keyed value = the patient's id), so a
 * Redis dump never leaks usable tokens. Each successful refresh ROTATES the
 * token (old one is deleted, a new one issued) — a stolen-then-used token is
 * invalidated the moment the legitimate client next refreshes, and `revoke`
 * (logout) kills the session immediately. This is the revocation the stateless
 * HMAC access token can't provide on its own.
 */
@Injectable()
export class RefreshTokenService {
  constructor(private readonly redisService: RedisService) {}

  private keyOf(rawToken: string): string {
    const hash = createHash('sha256').update(rawToken).digest('hex');
    return `pfos:refresh:${hash}`;
  }

  /** Mint a refresh token for `sub` and persist its hash (30d TTL). */
  async issue(sub: string): Promise<string> {
    const raw = randomBytes(32).toString('hex');
    await this.redisService.redis.set(this.keyOf(raw), sub, 'EX', REFRESH_TTL_SECONDS);
    return raw;
  }

  /**
   * Validate a refresh token and rotate it: returns the owning `sub` plus a
   * fresh refresh token, invalidating the presented one. Throws if unknown or
   * expired.
   */
  async verifyAndRotate(rawToken: string): Promise<{ sub: string; refreshToken: string }> {
    const key = this.keyOf(rawToken);
    const sub = await this.redisService.redis.get(key);
    if (!sub) throw new UnauthorizedException('invalid or expired refresh token');
    await this.redisService.redis.del(key); // rotate: the old token is now dead
    const refreshToken = await this.issue(sub);
    return { sub, refreshToken };
  }

  /** Logout / explicit revocation — drop the token from the store. */
  async revoke(rawToken: string): Promise<void> {
    await this.redisService.redis.del(this.keyOf(rawToken));
  }
}
