import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, SessionType } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { QueueService, QueueEntry } from './queue.service';
import { QueueEventsService } from './queue-events.service';
import {
  SessionKey,
  TokenSource,
  tokenCounterKey,
  tokenPrefix,
} from './token.service';

const LOCK_TTL_MS = 5000;
const LOCK_RETRY_MS = 15;
const LOCK_WAIT_MS = 5000;

/** Release lock only if we still own it (compare-and-delete). */
const UNLOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface DoneResult {
  doneToken: string;
  doneBookingId: string | null;
  newActiveToken: string | null;
  newActiveBookingId: string | null;
}

export interface NoShowResult {
  noShowToken: string;
  noShowBookingId: string | null;
  wasActive: boolean; // true if the patient was at rank 0
  newActiveToken: string | null; // promoted front (only when wasActive)
  newActiveBookingId: string | null;
}

export interface SkipResult {
  skippedToken: string;
  skippedBookingId: string | null;
  wasActive: boolean;
  newActiveToken: string | null; // promoted front (only when wasActive)
  newActiveBookingId: string | null;
}

export interface PriorityResult {
  token: string;
  score: number;
  isActive: boolean; // empty queue -> became ACTIVE immediately
}

export interface ReinsertResult {
  token: string;
  afterToken: string;
  score: number;
}

/**
 * Owns queue advancement + the booking-status / consultation-timestamp writes
 * that go with it. Redis is the ordering source of truth; Postgres records the
 * lifecycle (BOOKED -> ACTIVE -> COMPLETED) and the consultation timestamps,
 * which can only be captured at these exact moments.
 */
@Injectable()
export class ConsultationService {
  private unlockReady = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    private readonly redisService: RedisService,
    private readonly events: QueueEventsService,
  ) {}

  /**
   * Run `fn` while holding a per-session advance lock. DONE is a serial
   * operation per doctor — this serialises the pop + status writes so
   * concurrent/duplicate presses can't interleave (which would otherwise let a
   * token be COMPLETED before it was promoted to ACTIVE).
   */
  private async withSessionLock<T>(
    session: SessionKey,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.unlockReady) {
      this.redisService.defineCommand('pfosUnlock', {
        numberOfKeys: 1,
        lua: UNLOCK_LUA,
      });
      this.unlockReady = true;
    }

    const key = `pfos:lock:advance:${session.doctorId}:${session.sessionDate}:${session.sessionType}`;
    const owner = randomUUID();
    const redis = this.redisService.redis;

    const deadline = Date.now() + LOCK_WAIT_MS;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const ok = await redis.set(key, owner, 'PX', LOCK_TTL_MS, 'NX');
      if (ok === 'OK') break;
      if (Date.now() > deadline) {
        throw new ConflictException('queue is busy, retry');
      }
      await new Promise((r) => setTimeout(r, LOCK_RETRY_MS));
    }

    try {
      return await fn();
    } finally {
      const unlock = (
        this.redisService.redis as unknown as {
          pfosUnlock: (k: string, owner: string) => Promise<number>;
        }
      ).pfosUnlock.bind(this.redisService.redis);
      await unlock(key, owner);
    }
  }

  /**
   * Highest token sequence Postgres already holds for this session + prefix.
   *
   * Only consulted when the Redis counter is missing: Redis is volatile and
   * Postgres is not, so a wiped/restarted Redis would otherwise restart at
   * A001 and collide with rows that already exist (unique index on
   * doctor_id + session_date + session_type + token_number). Returns 0 when
   * there is nothing to catch up to. See BASELINE note in queue.service.
   */
  private async tokenBaselineFor(
    source: TokenSource,
    session: SessionKey,
  ): Promise<number> {
    const exists = await this.redisService.redis.exists(
      tokenCounterKey(source, session),
    );
    if (exists) return 0; // counter is live — never override it

    const prefix = tokenPrefix(source);
    const rows = await this.prisma.booking.findMany({
      where: {
        doctorId: session.doctorId,
        sessionDate: new Date(`${session.sessionDate}T00:00:00.000Z`),
        sessionType: session.sessionType as SessionType,
        tokenNumber: { startsWith: prefix },
      },
      select: { tokenNumber: true },
    });

    let max = 0;
    for (const { tokenNumber } of rows) {
      const seq = Number.parseInt((tokenNumber ?? '').slice(prefix.length), 10);
      if (Number.isFinite(seq) && seq > max) max = seq;
    }
    return max;
  }

  /**
   * Enqueue a paid booking. If it lands at rank 0 (empty queue) it is promoted
   * to ACTIVE immediately — i.e. the doctor can see them now.
   */
  async enqueueBooking(
    source: TokenSource,
    session: SessionKey,
    bookingId: string,
  ): Promise<QueueEntry> {
    const baseline = await this.tokenBaselineFor(source, session);
    const entry = await this.queue.enqueue(source, session, bookingId, baseline);
    if (entry.isFront) {
      await this.promote(entry.tokenNumber, session);
    }
    this.events.sessionChanged(session);
    return entry;
  }

  /**
   * Promote a token to ACTIVE and stamp consultation_started_at.
   *
   * Guarded to ONLY transition BOOKED -> ACTIVE. This is both idempotent (a
   * re-promote of an already-ACTIVE token is a no-op, so started_at is never
   * overwritten) and race-safe: under concurrent DONE presses a token that has
   * already been COMPLETED can never be dragged back to ACTIVE.
   */
  async promote(token: string, session: SessionKey): Promise<void> {
    const bookingId = await this.queue.bookingIdFor(token, session);
    if (!bookingId) return; // no DB booking mapped (e.g. raw-token test traffic)

    await this.prisma.booking.updateMany({
      where: { id: bookingId, status: BookingStatus.BOOKED },
      data: {
        status: BookingStatus.ACTIVE,
        consultationStartedAt: new Date(),
      },
    });
  }

  /**
   * DONE for the current rank-0 patient:
   *   COMPLETED + consultation_ended_at -> ZPOPMIN -> promote whatever is now front.
   *
   * The check-and-pop is atomic (DONE_LUA), so concurrent presses can't skip a
   * patient and a stale-token press is rejected.
   */
  async markDone(session: SessionKey, expectedToken = ''): Promise<DoneResult> {
    return this.withSessionLock(session, async () => {
      const outcome = await this.queue.popFront(session, expectedToken);

      if (outcome.status === 'EMPTY') {
        throw new NotFoundException('no active patient in queue');
      }
      if (outcome.status === 'MISMATCH') {
        throw new ConflictException(
          `active patient is ${outcome.activeToken}, not ${expectedToken}`,
        );
      }

      const { doneToken, newFrontToken } = outcome;

      // complete the consulted patient
      const doneBookingId = await this.queue.bookingIdFor(doneToken, session);
      if (doneBookingId) {
        await this.prisma.booking.updateMany({
          where: { id: doneBookingId, status: { not: BookingStatus.COMPLETED } },
          data: {
            status: BookingStatus.COMPLETED,
            consultationEndedAt: new Date(),
          },
        });
      }
      await this.queue.unmapToken(doneToken, session);

      // promote the new front (if any). Inside the lock, so the next press
      // can't pop this token before it is ACTIVE.
      let newActiveBookingId: string | null = null;
      if (newFrontToken) {
        await this.promote(newFrontToken, session);
        newActiveBookingId = await this.queue.bookingIdFor(newFrontToken, session);
      }

      this.events.sessionChanged(session);
      return {
        doneToken,
        doneBookingId,
        newActiveToken: newFrontToken,
        newActiveBookingId,
      };
    });
  }

  /**
   * No-show for a specific token. Under the SAME per-session advance lock as
   * DONE — so a no-show and a DONE racing for the same active patient can't
   * both win.
   *
   *  - ACTIVE (rank 0): remove front -> NO_SHOW (ended_at stays null) -> promote
   *    the new front exactly as DONE does.
   *  - BOOKED (mid-queue): plain ZREM -> NO_SHOW, no promotion side effects.
   *  - GONE (already removed/completed): reject cleanly, advance nothing.
   */
  /**
   * Remove a token from the live queue for a CANCELLATION, using the same
   * atomic no-show primitive (ACTIVE pops + promotes next; BOOKED plain ZREM;
   * GONE no-ops). Does NOT write a NO_SHOW status — the payments flow sets
   * CANCELLED. Returns the removed booking id (if mapped). No-op if not queued.
   */
  async cancelDequeue(
    session: SessionKey,
    token: string,
  ): Promise<{ removed: boolean; bookingId: string | null }> {
    return this.withSessionLock(session, async () => {
      const outcome = await this.queue.noShow(token, session);
      if (outcome.status === 'GONE') {
        return { removed: false, bookingId: null };
      }
      const bookingId = await this.queue.bookingIdFor(token, session);
      await this.queue.unmapToken(token, session);

      if (outcome.status === 'ACTIVE' && outcome.newFrontToken) {
        await this.promote(outcome.newFrontToken, session);
      }
      this.events.sessionChanged(session);
      return { removed: true, bookingId };
    });
  }

  async markNoShow(session: SessionKey, token: string): Promise<NoShowResult> {
    return this.withSessionLock(session, async () => {
      const outcome = await this.queue.noShow(token, session);

      if (outcome.status === 'GONE') {
        throw new ConflictException(
          `token ${token} is no longer in the queue`,
        );
      }

      const bookingId = await this.queue.bookingIdFor(token, session);
      if (bookingId) {
        // only valid from a live state; Redis GONE already guards double-action
        await this.prisma.booking.updateMany({
          where: {
            id: bookingId,
            status: {
              in: [BookingStatus.BOOKED, BookingStatus.ACTIVE],
            },
          },
          data: { status: BookingStatus.NO_SHOW }, // ended_at deliberately left null
        });
      }
      await this.queue.unmapToken(token, session);

      let newActiveToken: string | null = null;
      let newActiveBookingId: string | null = null;
      if (outcome.status === 'ACTIVE' && outcome.newFrontToken) {
        newActiveToken = outcome.newFrontToken;
        await this.promote(newActiveToken, session);
        newActiveBookingId = await this.queue.bookingIdFor(newActiveToken, session);
      }

      this.events.sessionChanged(session);
      return {
        noShowToken: token,
        noShowBookingId: bookingId,
        wasActive: outcome.status === 'ACTIVE',
        newActiveToken,
        newActiveBookingId,
      };
    });
  }

  /**
   * Skip a patient to the back of the queue (they keep their token + booking).
   * ACTIVE: pop front (-> back), revert that booking to BOOKED with started_at
   * cleared, promote the new front. BOOKED: just moves to the back, no status
   * change. Stale (GONE) rejects. All under the per-session advance lock.
   */
  async skip(session: SessionKey, token: string): Promise<SkipResult> {
    return this.withSessionLock(session, async () => {
      const outcome = await this.queue.skip(token, session);
      if (outcome.status === 'GONE') {
        throw new ConflictException(`token ${token} is no longer in the queue`);
      }

      const skippedBookingId = await this.queue.bookingIdFor(token, session);

      let newActiveToken: string | null = null;
      let newActiveBookingId: string | null = null;

      if (outcome.status === 'ACTIVE') {
        // skipped patient was being seen -> back to waiting, un-stamp start
        if (skippedBookingId) {
          await this.prisma.booking.updateMany({
            where: { id: skippedBookingId, status: BookingStatus.ACTIVE },
            data: { status: BookingStatus.BOOKED, consultationStartedAt: null },
          });
        }
        if (outcome.newFrontToken) {
          newActiveToken = outcome.newFrontToken;
          await this.promote(newActiveToken, session);
          newActiveBookingId = await this.queue.bookingIdFor(newActiveToken, session);
        }
      }
      // BOOKED case: token stays BOOKED, just reordered — no DB change.

      this.events.sessionChanged(session);
      return {
        skippedToken: token,
        skippedBookingId,
        wasActive: outcome.status === 'ACTIVE',
        newActiveToken,
        newActiveBookingId,
      };
    });
  }

  /**
   * Emergency-priority insert of a NEW booking just behind the active patient
   * (ahead of any previously-prioritized but still-waiting patient). If the
   * queue is empty it becomes ACTIVE immediately, like enqueueBooking.
   */
  async priorityInsert(
    source: TokenSource,
    session: SessionKey,
    bookingId: string,
  ): Promise<PriorityResult> {
    return this.withSessionLock(session, async () => {
      const baseline = await this.tokenBaselineFor(source, session);
      const res = await this.queue.priorityInsert(
        source,
        session,
        bookingId,
        baseline,
      );
      if (res.status === 'PRECISION') {
        throw new ConflictException(
          'priority score precision exhausted for this gap; renormalization needed',
        );
      }
      if (res.isFront) {
        await this.promote(res.token, session);
      }
      this.events.sessionChanged(session);
      return { token: res.token, score: res.score, isActive: res.isFront };
    });
  }

  /**
   * Reinsert a NO_SHOW patient after an existing in-queue anchor token. Only
   * valid from NO_SHOW; transitions NO_SHOW -> BOOKED on success. Rejects if the
   * anchor is gone, the token is already queued, or the status isn't NO_SHOW.
   */
  async reinsert(
    session: SessionKey,
    token: string,
    afterToken: string,
    bookingId: string,
  ): Promise<ReinsertResult> {
    return this.withSessionLock(session, async () => {
      const booking = await this.prisma.booking.findUnique({
        where: { id: bookingId },
        select: { status: true },
      });
      if (!booking) throw new NotFoundException(`booking ${bookingId} not found`);
      if (booking.status !== BookingStatus.NO_SHOW) {
        throw new ConflictException('reinsert is only valid from NO_SHOW status');
      }

      const outcome = await this.queue.reinsertAfter(
        token,
        afterToken,
        session,
        bookingId,
      );
      if (outcome.status === 'GONE') {
        throw new ConflictException(`anchor token ${afterToken} is no longer in the queue`);
      }
      if (outcome.status === 'PRESENT') {
        throw new ConflictException(`token ${token} is already in the queue`);
      }
      if (outcome.status === 'PRECISION') {
        throw new ConflictException(
          'reinsert score precision exhausted for this gap; renormalization needed',
        );
      }

      // NO_SHOW -> BOOKED (guarded; will be promoted later by a DONE)
      await this.prisma.booking.updateMany({
        where: { id: bookingId, status: BookingStatus.NO_SHOW },
        data: { status: BookingStatus.BOOKED },
      });

      this.events.sessionChanged(session);
      return { token, afterToken, score: outcome.score };
    });
  }
}
