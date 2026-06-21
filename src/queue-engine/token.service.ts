import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';

/**
 * Source of a booking. Determines the token prefix. Mirrors Prisma's
 * BookingSource — kept here to avoid coupling the engine to the DB enum import.
 *
 * APP and VOICE deliberately share the "A" prefix AND the same counter, so a
 * given session never produces two different "A001"s. The booking's `source`
 * column (not the prefix) is the truth for analytics/filtering.
 */
export enum TokenSource {
  APP = 'APP', // mobile/app bookings   -> "A001", "A002", ...
  WALK_IN = 'WALK_IN', // reception walk-ins    -> "W001", "W002", ...
  VOICE = 'VOICE', // voice bookings (P2)   -> "A###", shares APP's counter
}

const PREFIX: Record<TokenSource, string> = {
  [TokenSource.APP]: 'A',
  [TokenSource.WALK_IN]: 'W',
  [TokenSource.VOICE]: 'A', // shares APP's "A" counter — see note above
};

export interface SessionKey {
  doctorId: string;
  sessionDate: string; // ISO date 'YYYY-MM-DD'
  sessionType: string; // e.g. 'MORNING' | 'EVENING'
}

export interface IssuedToken {
  tokenNumber: string; // e.g. "A001"
  sequence: number; // raw monotonic counter value (1-based)
  source: TokenSource;
}

/** min digits to zero-pad token numbers; longer sequences just grow (A1000). */
export const TOKEN_PAD = 3;

/** Token prefix for a source. APP and VOICE share "A". */
export function tokenPrefix(source: TokenSource): string {
  return PREFIX[source];
}

/** Redis key for a source's token counter within one doctor/session. */
export function tokenCounterKey(source: TokenSource, s: SessionKey): string {
  return `pfos:token:${PREFIX[source]}:${s.doctorId}:${s.sessionDate}:${s.sessionType}`;
}

/** Format a token number from prefix + 1-based sequence (e.g. APP, 1 -> "A001"). */
export function formatToken(source: TokenSource, sequence: number): string {
  return `${PREFIX[source]}${String(sequence).padStart(TOKEN_PAD, '0')}`;
}

/**
 * Issues sequential, collision-free tokens per doctor/session.
 *
 * Correctness rule (hard): the next number is produced by a single Redis
 * INCR — an atomic server-side operation. There is NO read-then-write in
 * application code, so N concurrent callers always receive N distinct,
 * contiguous sequence values. App tokens (A) and walk-in tokens (W) use
 * independent counters but the same atomic mechanism.
 */
@Injectable()
export class TokenService {
  constructor(private readonly redisService: RedisService) {}

  /**
   * Atomically issue the next token for the given source.
   * Concurrency-safe by construction (single INCR).
   *
   * NOTE: this issues a token number only — it does NOT place the booking in
   * the ordered queue. Use QueueService.enqueue for the unified queue, which
   * issues the token AND assigns a shared arrival-ordering score atomically.
   */
  async issueToken(source: TokenSource, session: SessionKey): Promise<IssuedToken> {
    const sequence = await this.redisService.redis.incr(
      tokenCounterKey(source, session),
    );
    return {
      tokenNumber: formatToken(source, sequence),
      sequence,
      source,
    };
  }

  /** Convenience: app/mobile booking token (A###). */
  issueAppToken(session: SessionKey): Promise<IssuedToken> {
    return this.issueToken(TokenSource.APP, session);
  }

  /** Convenience: reception walk-in token (W###). */
  issueWalkInToken(session: SessionKey): Promise<IssuedToken> {
    return this.issueToken(TokenSource.WALK_IN, session);
  }

  /** Current counter value without incrementing (0 if none issued yet). */
  async peekCounter(source: TokenSource, session: SessionKey): Promise<number> {
    const v = await this.redisService.redis.get(tokenCounterKey(source, session));
    return v ? Number.parseInt(v, 10) : 0;
  }

  /**
   * Reset a session's counter. Test/teardown helper only — never call from
   * request paths; it would reintroduce collisions.
   */
  async resetCounter(source: TokenSource, session: SessionKey): Promise<void> {
    await this.redisService.redis.del(tokenCounterKey(source, session));
  }
}
