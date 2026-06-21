import { Injectable } from '@nestjs/common';
import { RedisService } from '../common/redis/redis.service';
import {
  SessionKey,
  TokenSource,
  tokenCounterKey,
  tokenPrefix,
  TOKEN_PAD,
} from './token.service';

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

/**
 * Lua: issue token + assign shared arrival score + place in the ordered set —
 * all in one atomic server-side step. Guarantees:
 *  - token number is collision-free (per-prefix INCR)
 *  - arrival score is a SINGLE shared monotonic sequence per doctor/session,
 *    so A and W tokens interleave by true arrival, not per-prefix order
 *  - no window where a token exists but isn't placed (or vice-versa)
 *
 * KEYS[1] token counter (A or W)   KEYS[2] shared arrival seq   KEYS[3] queue zset
 * ARGV[1] prefix ("A"/"W")         ARGV[2] zero-pad width
 * returns { tokenSeq, arrivalScore, tokenNumber }
 */
const ENQUEUE_LUA = `
local tokenSeq = redis.call('INCR', KEYS[1])
local score = redis.call('INCR', KEYS[2])
local token = ARGV[1] .. string.format('%0' .. ARGV[2] .. 'd', tokenSeq)
redis.call('ZADD', KEYS[3], score, token)
if ARGV[3] ~= '' then redis.call('HSET', KEYS[4], token, ARGV[3]) end
local card = redis.call('ZCARD', KEYS[3])
return { tokenSeq, score, token, card }
`;

/**
 * Atomic DONE: check-and-pop the front of the queue.
 *
 * Guards concurrency: two DONE presses for the same session can't both pop the
 * same patient (so nobody is skipped), and a press for a stale token is
 * rejected instead of advancing the wrong person.
 *
 * KEYS[1] queue zset                ARGV[1] expectedToken ('' = no check)
 * returns {'EMPTY'} | {'MISMATCH', actualFront} | {'OK', doneToken, newFront(''|token)}
 */
const DONE_LUA = `
local front = redis.call('ZRANGE', KEYS[1], 0, 0)
if #front == 0 then return { 'EMPTY' } end
if ARGV[1] ~= '' and front[1] ~= ARGV[1] then return { 'MISMATCH', front[1] } end
redis.call('ZPOPMIN', KEYS[1])
local nf = redis.call('ZRANGE', KEYS[1], 0, 0)
local newFront = ''
if #nf > 0 then newFront = nf[1] end
return { 'OK', front[1], newFront }
`;

/**
 * Atomic no-show removal of a SPECIFIC token. Decides ACTIVE vs BOOKED vs GONE
 * by the token's current rank, then removes it — in one step so the decision
 * and removal can't drift.
 *
 * KEYS[1] queue zset        ARGV[1] target token
 * returns {'GONE'} | {'ACTIVE', newFront(''|token)} | {'BOOKED'}
 */
const NOSHOW_LUA = `
local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
if rank == false then return { 'GONE' } end
redis.call('ZREM', KEYS[1], ARGV[1])
if rank == 0 then
  local nf = redis.call('ZRANGE', KEYS[1], 0, 0)
  local newFront = ''
  if #nf > 0 then newFront = nf[1] end
  return { 'ACTIVE', newFront }
end
return { 'BOOKED' }
`;

/**
 * Atomic SKIP: move a specific token to the BACK of the queue. New score is the
 * next value of the shared arrival sequence (always greater than every existing
 * score, fractional priority scores included), so the skipped patient lands
 * last. If it was rank 0, the new front is returned so the caller promotes it.
 *
 * KEYS[1] queue   KEYS[2] arrival seq   ARGV[1] target
 * returns {'GONE'} | {'ACTIVE', newFront} | {'BOOKED'}
 */
const SKIP_LUA = `
local rank = redis.call('ZRANK', KEYS[1], ARGV[1])
if rank == false then return { 'GONE' } end
local newScore = redis.call('INCR', KEYS[2])
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZADD', KEYS[1], newScore, ARGV[1])
if rank == 0 then
  local nf = redis.call('ZRANGE', KEYS[1], 0, 0)
  return { 'ACTIVE', nf[1] }
end
return { 'BOOKED' }
`;

/**
 * Atomic EMERGENCY-PRIORITY insert: issue a token, then place it just behind the
 * active patient. Score = midpoint(activeScore, firstWaitingScore). Because a
 * previously-prioritized patient is now the first-waiting one, a fresh priority
 * insert lands ahead of it. Empty queue -> normal arrival score + isFront=1.
 *
 * KEYS[1] tokenCounter  KEYS[2] arrival  KEYS[3] queue  KEYS[4] tokenmap
 * ARGV[1] prefix  ARGV[2] pad  ARGV[3] bookingId
 * returns { token, scoreStr, isFront }
 */
const PRIORITY_LUA = `
local card = redis.call('ZCARD', KEYS[3])
local score
local isFront = 0
if card == 0 then
  score = redis.call('INCR', KEYS[2])
  isFront = 1
else
  local top = redis.call('ZRANGE', KEYS[3], 0, 1, 'WITHSCORES')
  local activeScore = tonumber(top[2])
  local upper
  if #top >= 4 then upper = tonumber(top[4]) else upper = activeScore + 1 end
  score = (activeScore + upper) / 2
  -- float-precision guard: midpoint must sit strictly between the bounds
  if score <= activeScore or score >= upper then return { 'PRECISION' } end
end
-- token only issued AFTER the guard passes (no wasted token number on reject)
local tokenSeq = redis.call('INCR', KEYS[1])
local token = ARGV[1] .. string.format('%0' .. ARGV[2] .. 'd', tokenSeq)
redis.call('ZADD', KEYS[3], score, token)
if ARGV[3] ~= '' then redis.call('HSET', KEYS[4], token, ARGV[3]) end
return { 'OK', token, tostring(score), isFront }
`;

/**
 * Atomic REINSERT after an existing in-queue token. Score = midpoint(anchorScore,
 * nextMemberScore). Rejects if the token is already present, or the anchor is
 * gone by the time it runs.
 *
 * KEYS[1] queue   KEYS[2] tokenmap
 * ARGV[1] token   ARGV[2] afterToken   ARGV[3] bookingId
 * returns {'PRESENT'} | {'GONE'} | {'OK', scoreStr}
 */
const REINSERT_LUA = `
if redis.call('ZRANK', KEYS[1], ARGV[1]) ~= false then return { 'PRESENT' } end
local afterRank = redis.call('ZRANK', KEYS[1], ARGV[2])
if afterRank == false then return { 'GONE' } end
local lower = tonumber(redis.call('ZSCORE', KEYS[1], ARGV[2]))
local nextm = redis.call('ZRANGE', KEYS[1], afterRank + 1, afterRank + 1, 'WITHSCORES')
local upper
if #nextm >= 2 then upper = tonumber(nextm[2]) else upper = lower + 1 end
local score = (lower + upper) / 2
if score <= lower or score >= upper then return { 'PRECISION' } end
redis.call('ZADD', KEYS[1], score, ARGV[1])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[2], ARGV[1], ARGV[3]) end
return { 'OK', tostring(score) }
`;

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
   */
  async enqueue(
    source: TokenSource,
    session: SessionKey,
    bookingId = '',
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
    );
    if (res[0] === 'PRECISION') return { status: 'PRECISION' };
    return {
      status: 'OK',
      token: res[1],
      score: Number(res[2]),
      isFront: Number(res[3]) === 1,
    };
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
