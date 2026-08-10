import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import { SessionClaims } from './auth-token.service';

/**
 * Longest life any access token can have (see `AuthTokenService.sign`'s default
 * TTL). Both revocation records are kept at least this long: past that point the
 * token they would reject has expired on its own, so the record is dead weight.
 */
export const ACCESS_TOKEN_MAX_TTL_SECONDS = 3600;

/** Small margin so a record never lapses fractionally before the token does. */
const TTL_MARGIN_SECONDS = 60;

/**
 * Server-side revocation for the stateless HMAC access token.
 *
 * The access token carries its own expiry and is verified by signature alone, so
 * on its own it cannot be withdrawn: a leaked staff token stayed usable for its
 * full hour with no server-side remedy — firing a staff member or losing a
 * hospital laptop had no answer, because verification never touched a datastore.
 *
 * Two records, both in Redis, both self-expiring:
 *
 *  - PER TOKEN (`jti`): set on logout. Kills exactly one session and nothing
 *    else, so signing out on one workstation does not sign the same person out
 *    of another.
 *
 *  - PER PRINCIPAL (`gen`): a generation counter. Every token records the
 *    generation current when it was minted; bumping the counter invalidates
 *    every token below it in one write. This is the "revoke everything" lever
 *    used on password change and account deletion, where the point is precisely
 *    that sessions the operator cannot enumerate must stop working.
 *
 * The generation is a counter rather than a timestamp on purpose. A timestamp
 * has to answer "was this token issued before or after the revocation?", and at
 * one-second resolution a legitimate re-login in the same second as a password
 * change is indistinguishable from a session that predates it — so it is either
 * wrongly locked out or wrongly admitted. A counter read at mint time has no
 * such ambiguity: the new token carries the new generation and is simply valid.
 *
 * Both records expire on their own after `ACCESS_TOKEN_MAX_TTL_SECONDS`, because
 * a record only needs to outlive the tokens it rejects. There is no growing
 * denylist to prune and no operator cleanup step.
 */
@Injectable()
export class SessionRevocationService {
  private readonly logger = new Logger(SessionRevocationService.name);

  constructor(private readonly redisService: RedisService) {}

  private jtiKey(jti: string): string {
    return `pfos:session:revoked:${jti}`;
  }

  private generationKey(sub: string): string {
    return `pfos:session:gen:${sub}`;
  }

  /**
   * The generation a token minted for `sub` right now should carry. Absent key
   * = generation 0, the state of every principal that has never been revoked.
   */
  async currentGeneration(sub: string): Promise<number> {
    const raw = await this.redisService.redis.get(this.generationKey(sub));
    return raw ? Number(raw) : 0;
  }

  /**
   * Revoke one session (logout). TTL tracks the token's own remaining life, so
   * the record disappears as soon as the token would have expired anyway.
   */
  async revokeToken(claims: SessionClaims): Promise<void> {
    if (!claims.jti) return; // pre-jti token: nothing to key a record on
    const remaining = claims.exp
      ? claims.exp - Math.floor(Date.now() / 1000)
      : ACCESS_TOKEN_MAX_TTL_SECONDS;
    if (remaining <= 0) return; // already expired; verify() rejects it regardless
    await this.redisService.redis.set(
      this.jtiKey(claims.jti),
      '1',
      'EX',
      remaining + TTL_MARGIN_SECONDS,
    );
  }

  /**
   * Revoke every access token already issued to `sub` — password change,
   * deactivation, deletion, or a suspected compromise. Tokens minted after this
   * call carry the new generation and are unaffected.
   */
  async revokeAllForSubject(sub: string): Promise<void> {
    const key = this.generationKey(sub);
    const generation = await this.redisService.redis.incr(key);
    // Refreshed on every bump: the record must outlive the longest-lived token
    // it has to reject, and nothing longer.
    await this.redisService.redis.expire(
      key,
      ACCESS_TOKEN_MAX_TTL_SECONDS + TTL_MARGIN_SECONDS,
    );
    this.logger.log(`all sessions revoked for subject ${sub} (generation ${generation})`);
  }

  /** True if these claims have been revoked individually or by subject sweep. */
  async isRevoked(claims: SessionClaims): Promise<boolean> {
    const redis = this.redisService.redis;
    const [jtiHit, generation] = await Promise.all([
      claims.jti ? redis.get(this.jtiKey(claims.jti)) : Promise.resolve(null),
      claims.sub ? redis.get(this.generationKey(claims.sub)) : Promise.resolve(null),
    ]);

    if (jtiHit) return true;
    if (!generation) return false; // never revoked

    // A token with no `gen` predates this mechanism, so it cannot be placed
    // relative to the counter. Fail closed: the operator asked for every session
    // of this principal to stop, and "I can't tell which generation this is" is
    // not a reason to keep honouring it.
    if (claims.gen === undefined) return true;
    return claims.gen < Number(generation);
  }

  /** `isRevoked` as a guard clause — throws 401 rather than returning false. */
  async assertActive(claims: SessionClaims): Promise<void> {
    if (await this.isRevoked(claims)) {
      throw new UnauthorizedException('session revoked');
    }
  }
}
