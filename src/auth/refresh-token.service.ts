import { createHash, randomBytes } from 'node:crypto';
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/** Which login flow a refresh token belongs to. */
export type PrincipalKind = 'PATIENT' | 'STAFF' | 'DOCTOR';

export interface RefreshRecord {
  sub: string;
  kind: PrincipalKind;
}

/**
 * Opaque, rotating refresh tokens backed by Redis.
 *
 * The raw token is a random 256-bit string handed to the client; only its
 * SHA-256 hash is stored server-side (keyed value = the owner's id and kind), so
 * a Redis dump never leaks usable tokens. Each successful refresh ROTATES the
 * token (old one is deleted, a new one issued) — a stolen-then-used token is
 * invalidated the moment the legitimate client next refreshes, and `revoke`
 * (logout) kills the session immediately. This is the revocation the stateless
 * HMAC access token can't provide on its own.
 *
 * The stored value carries the principal KIND as well as the id. A refresh
 * token minted for a patient must not be redeemable at the staff refresh route:
 * ids are UUIDs from different tables and could otherwise be confused across
 * flows, so the redeeming route asserts the kind it expects.
 *
 * A per-subject index of live token keys is maintained alongside, which is what
 * makes `revokeAllForSubject` possible — without it the store is only
 * addressable by token hash, and "log this person out everywhere" (password
 * change, deactivation) has nothing to enumerate.
 */
@Injectable()
export class RefreshTokenService {
  constructor(private readonly redisService: RedisService) {}

  private keyOf(rawToken: string): string {
    const hash = createHash('sha256').update(rawToken).digest('hex');
    return `pfos:refresh:${hash}`;
  }

  private indexKeyOf(sub: string): string {
    return `pfos:refresh:subject:${sub}`;
  }

  /** Mint a refresh token for `sub` and persist its hash (30d TTL). */
  async issue(sub: string, kind: PrincipalKind = 'PATIENT'): Promise<string> {
    const raw = randomBytes(32).toString('hex');
    const key = this.keyOf(raw);
    await this.redisService.redis
      .multi()
      .set(key, `${kind}:${sub}`, 'EX', REFRESH_TTL_SECONDS)
      .sadd(this.indexKeyOf(sub), key)
      // The index must outlive every token it points at, otherwise a bulk
      // revoke would silently miss the tokens whose index entry lapsed first.
      .expire(this.indexKeyOf(sub), REFRESH_TTL_SECONDS)
      .exec();
    return raw;
  }

  /**
   * Validate a refresh token and rotate it: returns the owner plus a fresh
   * refresh token, invalidating the presented one. Throws if unknown, expired,
   * or not of the expected kind.
   */
  async verifyAndRotate(
    rawToken: string,
    expectedKind: PrincipalKind = 'PATIENT',
  ): Promise<{ sub: string; kind: PrincipalKind; refreshToken: string }> {
    const key = this.keyOf(rawToken);
    const stored = await this.redisService.redis.get(key);
    if (!stored) throw new UnauthorizedException('invalid or expired refresh token');

    const { sub, kind } = parseRecord(stored);
    if (kind !== expectedKind) {
      // Burn it: a token presented at the wrong route is either a client bug or
      // an attempt to cross flows, and neither deserves a second attempt.
      await this.forget(key, sub);
      throw new UnauthorizedException('invalid or expired refresh token');
    }

    await this.forget(key, sub); // rotate: the old token is now dead
    const refreshToken = await this.issue(sub, kind);
    return { sub, kind, refreshToken };
  }

  /** Logout / explicit revocation — drop the token from the store. */
  async revoke(rawToken: string): Promise<void> {
    const key = this.keyOf(rawToken);
    const stored = await this.redisService.redis.get(key);
    const sub = stored ? parseRecord(stored).sub : undefined;
    await this.forget(key, sub);
  }

  /**
   * Drop every refresh token belonging to `sub`. Paired with
   * `SessionRevocationService.revokeAllForSubject`: that stops the short-lived
   * access tokens, this stops them being minted again.
   */
  async revokeAllForSubject(sub: string): Promise<void> {
    const redis = this.redisService.redis;
    const index = this.indexKeyOf(sub);
    const keys = await redis.smembers(index);
    if (keys.length > 0) await redis.del(...keys);
    await redis.del(index);
  }

  private async forget(key: string, sub?: string): Promise<void> {
    const redis = this.redisService.redis;
    await (sub ? redis.multi().del(key).srem(this.indexKeyOf(sub), key).exec() : redis.del(key));
  }
}

/**
 * Records written before the kind prefix existed are bare subject ids, and all
 * of those are patients — staff and doctors had no refresh token at all.
 */
function parseRecord(stored: string): RefreshRecord {
  const sep = stored.indexOf(':');
  if (sep < 0) return { sub: stored, kind: 'PATIENT' };
  const kind = stored.slice(0, sep) as PrincipalKind;
  return { sub: stored.slice(sep + 1), kind };
}
