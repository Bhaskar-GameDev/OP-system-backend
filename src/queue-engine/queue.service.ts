import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import {
  SessionKey,
  TokenSource,
  tokenCounterKey,
  tokenPrefix,
  TOKEN_PAD,
} from './token.service';
import {
  ENQUEUE_LUA,
  DONE_LUA,
  NOSHOW_LUA,
  SKIP_LUA,
  PRIORITY_LUA,
  PRIORITY_MOVE_LUA,
  REINSERT_LUA,
} from './queue.scripts';

export interface QueueEntry {
  tokenNumber: string; // display token, e.g. "A001" / "W001"
  arrivalScore: number; // shared monotonic arrival sequence (sort key)
  tokenSequence: number; // per-prefix token counter value
  source: TokenSource; // true source from the caller — never parsed from prefix
  isFront: boolean; // landed at rank 0 (queue was empty) -> caller promotes it
}

/** Result of an atomic DONE (check-and-pop) on the front of the queue. */
export type DoneOutcome =
  | { status: 'EMPTY' }
  | { status: 'MISMATCH'; activeToken: string } // someone else is at rank 0
  | { status: 'OK'; doneToken: string; newFrontToken: string | null };

/** Result of an atomic no-show removal of a specific token. */
export type NoShowOutcome =
  | { status: 'GONE' } // token already left the queue (stale request)
  | { status: 'ACTIVE'; newFrontToken: string | null } // was rank 0 -> promote next
  | { status: 'BOOKED' }; // was mid-queue -> plain removal, no promotion

/** Result of an atomic skip (move target to the back of the queue). */
export type SkipOutcome =
  | { status: 'GONE' }
  | { status: 'ACTIVE'; newFrontToken: string | null } // was rank 0 -> promote next
  | { status: 'BOOKED' }; // was mid-queue -> just moved to the back

/** Result of an atomic emergency-priority insert. */
export type PriorityInsertOutcome =
  | { status: 'PRECISION' } // midpoint collided with a bound (float exhaustion)
  | { status: 'OK'; token: string; score: number; isFront: boolean };

/**
 * Result of moving an ALREADY-QUEUED token into the priority slot. `FRONT` means
 * the token is the active patient, so there is nothing to jump ahead of.
 */
export type PriorityMoveOutcome =
  | { status: 'GONE' } // token is not in the live queue (never queued / no-show)
  | { status: 'PRECISION' } // midpoint collided with a bound (float exhaustion)
  | { status: 'FRONT'; score: number } // already rank 0 — left untouched
  | { status: 'OK'; score: number };

/** Result of an atomic reinsert-after-token. */
export type ReinsertOutcome =
  | { status: 'GONE' } // anchor token no longer in queue
  | { status: 'PRESENT' } // token is somehow already queued
  | { status: 'PRECISION' } // midpoint collided with a bound (float exhaustion)
  | { status: 'OK'; score: number };

/**
 * Read-back view of a queued slot. Deliberately has NO `source`: Redis only
 * stores the token string, and source must never be derived from the prefix.
 * Join the DB booking by tokenNumber when source is needed.
 */
export interface QueueSlot {
  tokenNumber: string;
  arrivalScore: number;
}

export interface QueuePosition {
  tokenNumber: string;
  patientsAhead: number; // count strictly ahead in the merged queue
  position: number; // 1-based position
  total: number; // current queue size
}

@Injectable()
export class QueueService {
  private commandReady = false;

  constructor(private readonly redisService: RedisService) {}

  private ensureCommand(): void {
    if (this.commandReady) return;
    this.redisService.defineCommand('pfosEnqueue', {
      numberOfKeys: 4,
      lua: ENQUEUE_LUA,
    });
    this.redisService.defineCommand('pfosDone', {
      numberOfKeys: 1,
      lua: DONE_LUA,
    });
    this.redisService.defineCommand('pfosNoShow', {
      numberOfKeys: 1,
      lua: NOSHOW_LUA,
    });
    this.redisService.defineCommand('pfosSkip', {
      numberOfKeys: 2,
      lua: SKIP_LUA,
    });
    this.redisService.defineCommand('pfosPriority', {
      numberOfKeys: 4,
      lua: PRIORITY_LUA,
    });
    this.redisService.defineCommand('pfosPriorityMove', {
      numberOfKeys: 1,
      lua: PRIORITY_MOVE_LUA,
    });
    this.redisService.defineCommand('pfosReinsert', {
      numberOfKeys: 2,
      lua: REINSERT_LUA,
    });
    this.commandReady = true;
  }

  /** Shared arrival-sequence key — ONE per doctor/session, used by all sources. */
  private arrivalKey(s: SessionKey): string {
    return `pfos:arrival:${s.doctorId}:${s.sessionDate}:${s.sessionType}`;
  }

  /** Ordered queue (sorted set), scored by arrival sequence. */
  private queueKey(s: SessionKey): string {
    return `pfos:queue:${s.doctorId}:${s.sessionDate}:${s.sessionType}`;
  }

  /** token -> bookingId map (hash) for this session. */
  private tokenMapKey(s: SessionKey): string {
    return `pfos:tokenmap:${s.doctorId}:${s.sessionDate}:${s.sessionType}`;
  }

  /**
   * Atomically issue a token AND place it in the merged ordered queue.
   * If bookingId is given it is mapped to the token (for later DB updates).
   * `isFront` is true when the queue was empty and this entry is now rank 0.
   *
   * `displayToken` overrides the minted number with one the OP engine already
   * issued for this visit, so a dual-written patient carries ONE number across
   * both engines instead of a legacy W001 next to an OP N001. The returned
   * `tokenSequence` stays the legacy counter's — only the display string changes.
   */
  async enqueue(
    source: TokenSource,
    session: SessionKey,
    bookingId = '',
    tokenBaseline = 0,
    displayToken = '',
  ): Promise<QueueEntry> {
    this.ensureCommand();

    // ioredis attaches defineCommand'd methods dynamically; type the call site
    // narrowly instead of using `any`.
    const run = (
      this.redisService.redis as unknown as {
        pfosEnqueue: (
          tokenKey: string,
          arrivalKey: string,
          queueKey: string,
          tokenMapKey: string,
          prefix: string,
          pad: string,
          bookingId: string,
          tokenBaseline: string,
          displayToken: string,
        ) => Promise<[number, number, string, number]>;
      }
    ).pfosEnqueue.bind(this.redisService.redis);

    const [tokenSeq, score, token, card] = await run(
      tokenCounterKey(source, session),
      this.arrivalKey(session),
      this.queueKey(session),
      this.tokenMapKey(session),
      tokenPrefix(source),
      String(TOKEN_PAD),
      bookingId,
      tokenBaseline > 0 ? String(tokenBaseline) : '',
      displayToken,
    );

    return {
      tokenNumber: String(token),
      arrivalScore: Number(score),
      tokenSequence: Number(tokenSeq),
      source,
      isFront: Number(card) === 1,
    };
  }

  /** Atomic check-and-pop of the front token (DONE). See DONE_LUA. */
  async popFront(
    session: SessionKey,
    expectedToken = '',
  ): Promise<DoneOutcome> {
    this.ensureCommand();

    const run = (
      this.redisService.redis as unknown as {
        pfosDone: (queueKey: string, expected: string) => Promise<string[]>;
      }
    ).pfosDone.bind(this.redisService.redis);

    const res = await run(this.queueKey(session), expectedToken);
    if (res[0] === 'EMPTY') return { status: 'EMPTY' };
    if (res[0] === 'MISMATCH') return { status: 'MISMATCH', activeToken: res[1] };
    return {
      status: 'OK',
      doneToken: res[1],
      newFrontToken: res[2] === '' ? null : res[2],
    };
  }

  /** Atomic no-show removal of a specific token. See NOSHOW_LUA. */
  async noShow(token: string, session: SessionKey): Promise<NoShowOutcome> {
    this.ensureCommand();

    const run = (
      this.redisService.redis as unknown as {
        pfosNoShow: (queueKey: string, token: string) => Promise<string[]>;
      }
    ).pfosNoShow.bind(this.redisService.redis);

    const res = await run(this.queueKey(session), token);
    if (res[0] === 'GONE') return { status: 'GONE' };
    if (res[0] === 'ACTIVE') {
      return { status: 'ACTIVE', newFrontToken: res[1] === '' ? null : res[1] };
    }
    return { status: 'BOOKED' };
  }

  /** Atomic skip: move target to the back of the queue. See SKIP_LUA. */
  async skip(token: string, session: SessionKey): Promise<SkipOutcome> {
    this.ensureCommand();
    const run = (
      this.redisService.redis as unknown as {
        pfosSkip: (
          queueKey: string,
          arrivalKey: string,
          token: string,
        ) => Promise<string[]>;
      }
    ).pfosSkip.bind(this.redisService.redis);

    const res = await run(
      this.queueKey(session),
      this.arrivalKey(session),
      token,
    );
    if (res[0] === 'GONE') return { status: 'GONE' };
    if (res[0] === 'ACTIVE') {
      return { status: 'ACTIVE', newFrontToken: res[1] === '' ? null : res[1] };
    }
    return { status: 'BOOKED' };
  }

  /** Atomic emergency-priority insert just behind the active patient. */
  async priorityInsert(
    source: TokenSource,
    session: SessionKey,
    bookingId = '',
    tokenBaseline = 0,
  ): Promise<PriorityInsertOutcome> {
    this.ensureCommand();
    const run = (
      this.redisService.redis as unknown as {
        pfosPriority: (
          tokenKey: string,
          arrivalKey: string,
          queueKey: string,
          tokenMapKey: string,
          prefix: string,
          pad: string,
          bookingId: string,
          tokenBaseline: string,
        ) => Promise<string[]>;
      }
    ).pfosPriority.bind(this.redisService.redis);

    const res = await run(
      tokenCounterKey(source, session),
      this.arrivalKey(session),
      this.queueKey(session),
      this.tokenMapKey(session),
      tokenPrefix(source),
      String(TOKEN_PAD),
      bookingId,
      tokenBaseline > 0 ? String(tokenBaseline) : '',
    );
    if (res[0] === 'PRECISION') return { status: 'PRECISION' };
    return {
      status: 'OK',
      token: res[1],
      score: Number(res[2]),
      isFront: Number(res[3]) === 1,
    };
  }

  /**
   * Atomic move of an already-queued token into the priority slot, keeping its
   * number. See PRIORITY_MOVE_LUA.
   */
  async priorityMove(
    token: string,
    session: SessionKey,
  ): Promise<PriorityMoveOutcome> {
    this.ensureCommand();
    const run = (
      this.redisService.redis as unknown as {
        pfosPriorityMove: (queueKey: string, token: string) => Promise<string[]>;
      }
    ).pfosPriorityMove.bind(this.redisService.redis);

    const res = await run(this.queueKey(session), token);
    if (res[0] === 'GONE') return { status: 'GONE' };
    if (res[0] === 'PRECISION') return { status: 'PRECISION' };
    if (res[0] === 'FRONT') return { status: 'FRONT', score: Number(res[1]) };
    return { status: 'OK', score: Number(res[1]) };
  }

  /** Atomic reinsert of a token after an existing anchor token. */
  async reinsertAfter(
    token: string,
    afterToken: string,
    session: SessionKey,
    bookingId = '',
  ): Promise<ReinsertOutcome> {
    this.ensureCommand();
    const run = (
      this.redisService.redis as unknown as {
        pfosReinsert: (
          queueKey: string,
          tokenMapKey: string,
          token: string,
          afterToken: string,
          bookingId: string,
        ) => Promise<string[]>;
      }
    ).pfosReinsert.bind(this.redisService.redis);

    const res = await run(
      this.queueKey(session),
      this.tokenMapKey(session),
      token,
      afterToken,
      bookingId,
    );
    if (res[0] === 'PRESENT') return { status: 'PRESENT' };
    if (res[0] === 'GONE') return { status: 'GONE' };
    if (res[0] === 'PRECISION') return { status: 'PRECISION' };
    return { status: 'OK', score: Number(res[1]) };
  }

  /** Resolve a token to its mapped bookingId (or null). */
  async bookingIdFor(token: string, session: SessionKey): Promise<string | null> {
    return this.redisService.redis.hget(this.tokenMapKey(session), token);
  }

  /**
   * The whole token → bookingId map for a session, in ONE round trip.
   *
   * The realtime broadcast needs every entry's booking id on every queue
   * mutation. Resolving them one at a time cost one Redis round trip per
   * waiting patient, per broadcast, per active doctor — measured at exactly 30
   * and 60 lookups for queues of those depths (see scripts/benchmark.ts). The
   * mapping is already a single hash, so the batched read is a plain HGETALL.
   */
  async bookingIdsFor(session: SessionKey): Promise<Record<string, string>> {
    return this.redisService.redis.hgetall(this.tokenMapKey(session));
  }

  /** Drop a token's booking mapping (after it leaves the queue). */
  async unmapToken(token: string, session: SessionKey): Promise<void> {
    await this.redisService.redis.hdel(this.tokenMapKey(session), token);
  }

  /** Current front token (rank 0) or null. */
  async frontToken(session: SessionKey): Promise<string | null> {
    const r = await this.redisService.redis.zrange(this.queueKey(session), 0, 0);
    return r.length > 0 ? r[0] : null;
  }

  /** Patients ahead + 1-based position for a token. null if not in queue. */
  async positionOf(
    token: string,
    session: SessionKey,
  ): Promise<QueuePosition | null> {
    const key = this.queueKey(session);
    const [rank, total] = await Promise.all([
      this.redisService.redis.zrank(key, token),
      this.redisService.redis.zcard(key),
    ]);
    if (rank === null) return null;
    return {
      tokenNumber: token,
      patientsAhead: rank, // ZRANK is 0-based => count strictly ahead
      position: rank + 1,
      total,
    };
  }

  /** Ordered token list (front -> back) reflecting true arrival sequence. */
  async list(session: SessionKey): Promise<string[]> {
    return this.redisService.redis.zrange(this.queueKey(session), 0, -1);
  }

  /**
   * Front slice only: the first `count` tokens (front -> back). For consumers
   * that only care about the head of the queue (e.g. threshold notifications)
   * — avoids scanning the full queue on every mutation.
   */
  async frontSlice(session: SessionKey, count: number): Promise<string[]> {
    if (count <= 0) return [];
    return this.redisService.redis.zrange(this.queueKey(session), 0, count - 1);
  }

  /** Ordered list with arrival scores (front -> back). No source — see QueueSlot. */
  async listWithScores(session: SessionKey): Promise<QueueSlot[]> {
    const flat = await this.redisService.redis.zrange(
      this.queueKey(session),
      0,
      -1,
      'WITHSCORES',
    );
    const out: QueueSlot[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push({ tokenNumber: flat[i], arrivalScore: Number(flat[i + 1]) });
    }
    return out;
  }

  async size(session: SessionKey): Promise<number> {
    return this.redisService.redis.zcard(this.queueKey(session));
  }

  /**
   * Remove a token from the ordered queue (ZREM). Primitive shared by
   * DONE / no-show / skip flows. Returns true if it was present. Removing a
   * member shifts everyone behind up by one ZRANK automatically — positions
   * (and therefore live ETA) stay correct with no recalc step.
   */
  async removeToken(token: string, session: SessionKey): Promise<boolean> {
    const removed = await this.redisService.redis.zrem(
      this.queueKey(session),
      token,
    );
    return removed > 0;
  }

  /** Test/teardown helper: wipe queue + shared arrival seq + token counters. */
  async clearSession(session: SessionKey): Promise<void> {
    await this.redisService.redis.del(
      this.queueKey(session),
      this.arrivalKey(session),
      this.tokenMapKey(session),
      tokenCounterKey(TokenSource.APP, session),
      tokenCounterKey(TokenSource.WALK_IN, session),
    );
  }
}
