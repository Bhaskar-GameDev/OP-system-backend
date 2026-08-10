import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../common/redis/redis.service';
import { MetricsService } from '../common/observability/metrics.service';

/**
 * Brute-force protection for privileged (username/password) logins.
 *
 * Staff and doctor credentials are the highest-value target in this system: one
 * ADMIN account exposes an entire hospital's patient data. Before this existed
 * the login routes had no throttle, no lockout and no failed-attempt record, so
 * an attacker could run an unlimited password list against them — and each
 * attempt also cost a cost-12 bcrypt verification, making it a CPU-exhaustion
 * vector at the same time.
 *
 * Two independent counters, because they defend against different attacks:
 *
 *  - PER IDENTIFIER (the submitted username): stops a password list against one
 *    known account. Deliberately keyed on the SUBMITTED string, not on a
 *    resolved account — an unknown username throttles exactly like a real one,
 *    so response behaviour never reveals whether an account exists.
 *
 *  - PER IP: stops an attacker rotating usernames to stay under the per-account
 *    limit. Set higher than the per-account limit because hospitals sit behind
 *    NAT and several staff legitimately share one egress IP.
 *
 * Both are TEMPORARY and self-expiring. There is no permanent lockout: an
 * attacker who floods a username can cost that user a short cooldown, never an
 * indefinite denial of service, and no operator action is needed to recover.
 *
 * The check runs BEFORE the password comparison, so a throttled request costs a
 * Redis read rather than a bcrypt hash.
 */
@Injectable()
export class LoginThrottleService {
  private readonly logger = new Logger(LoginThrottleService.name);

  constructor(
    private readonly redisService: RedisService,
    private readonly config: ConfigService,
    private readonly metrics: MetricsService,
  ) {}

  /** Failed attempts for one username before its cooldown starts. */
  private get maxPerIdentifier(): number {
    return this.config.get<number>('LOGIN_MAX_ATTEMPTS', 10);
  }

  /** Failed attempts from one IP before its cooldown starts. Higher: shared NAT. */
  private get maxPerIp(): number {
    return this.config.get<number>('LOGIN_MAX_ATTEMPTS_PER_IP', 30);
  }

  /** How long failures are remembered, and how long a cooldown lasts (seconds). */
  private get windowSeconds(): number {
    return this.config.get<number>('LOGIN_THROTTLE_WINDOW_SECONDS', 900); // 15 min
  }

  private identifierKey(scope: string, identifier: string): string {
    return `pfos:login:fail:${scope}:${identifier.trim().toLowerCase()}`;
  }
  private ipKey(ip: string): string {
    return `pfos:login:fail:ip:${ip}`;
  }

  /**
   * Reject the attempt if either counter is already at its limit.
   *
   * Throws 429 with a Retry-After hint. The message is identical for every
   * caller — it names no account and states nothing about whether the username
   * exists.
   */
  async assertNotThrottled(scope: string, identifier: string, ip: string): Promise<void> {
    const redis = this.redisService.redis;
    const [idCount, ipCount] = await Promise.all([
      redis.get(this.identifierKey(scope, identifier)),
      ip ? redis.get(this.ipKey(ip)) : Promise.resolve(null),
    ]);

    const overIdentifier = Number(idCount ?? 0) >= this.maxPerIdentifier;
    const overIp = Number(ipCount ?? 0) >= this.maxPerIp;
    if (!overIdentifier && !overIp) return;

    const key = overIdentifier ? this.identifierKey(scope, identifier) : this.ipKey(ip);
    const ttl = await redis.ttl(key);
    const retryAfter = ttl > 0 ? ttl : this.windowSeconds;

    // Log the fact, never the credential. The identifier is included because
    // operators need to know which account is under attack; the password is
    // not read, held or logged anywhere in this class.
    this.logger.warn(
      `login throttled (${overIdentifier ? 'identifier' : 'ip'}) scope=${scope} retryAfter=${retryAfter}s`,
    );
    // A rising throttle rate is a brute-force attempt in progress — the one
    // auth signal that should page someone rather than sit in a log file.
    this.metrics.loginThrottled.inc({ scope });

    throw new HttpException(
      {
        statusCode: HttpStatus.TOO_MANY_REQUESTS,
        message: 'too many failed login attempts; try again later',
        retryAfterSeconds: retryAfter,
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  /**
   * Record a failed attempt against both counters.
   *
   * The TTL is set only when a counter is created, so the window is a fixed
   * period from the FIRST failure rather than being extended by every
   * subsequent one — otherwise a persistent attacker could hold a legitimate
   * user in cooldown indefinitely, which is the account-lockout DoS this design
   * is specifically avoiding.
   */
  async recordFailure(scope: string, identifier: string, ip: string): Promise<void> {
    await Promise.all([
      this.bump(this.identifierKey(scope, identifier)),
      ip ? this.bump(this.ipKey(ip)) : Promise.resolve(),
    ]);
  }

  private async bump(key: string): Promise<void> {
    const redis = this.redisService.redis;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, this.windowSeconds);
  }

  /**
   * Clear the identifier counter after a successful login.
   *
   * The IP counter is deliberately NOT cleared: an attacker who happens to hold
   * one valid credential could otherwise reset their own IP budget between
   * bursts and brute-force other accounts from the same address indefinitely.
   */
  async recordSuccess(scope: string, identifier: string): Promise<void> {
    await this.redisService.redis.del(this.identifierKey(scope, identifier));
  }
}
