import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.service';
import { QueueService } from '../queue-engine/queue.service';
import { QueueEventsService } from '../queue-engine/queue-events.service';
import { SessionKey } from '../queue-engine/token.service';
import { PUSH_SENDER, PushMessage, PushSender } from './push.sender';

export enum NotificationType {
  BOOKING_CONFIRMED = 'BOOKING_CONFIRMED',
  QUEUE_APPROACHING = 'QUEUE_APPROACHING',
  ARRIVAL_REMINDER = 'ARRIVAL_REMINDER',
}

/**
 * Patient push notifications. A SECOND, independent consumer of the Queue
 * Engine's session-changed stream — it does NOT add trigger calls into the
 * DONE/no-show/skip/priority/reinsert handlers. One emit per mutation already
 * exists; this just listens.
 *
 * Threshold notifications (Approaching / Arrival) are threshold-CROSSINGS, not
 * state changes: on each mutation we scan only the front slice up to the max
 * configured threshold, and a per-booking-per-type idempotent flag (atomic
 * Redis SADD) guarantees each one fires exactly once — re-scans of an
 * unchanged head are no-ops.
 */
@Injectable()
export class NotificationsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationsService.name);
  private unsubscribe?: () => void;

  private readonly approachingAhead: number; // fire when patientsAhead <= this
  private readonly arrivalAhead: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly queue: QueueService,
    private readonly events: QueueEventsService,
    private readonly config: ConfigService,
    @Inject(PUSH_SENDER) private readonly push: PushSender,
  ) {
    // config values arrive as strings from env — coerce explicitly (a bare
    // <number> generic on config.get does NOT parse, it only casts the type).
    this.approachingAhead = Number(this.config.get('NOTIFY_APPROACHING_AHEAD', 3));
    this.arrivalAhead = Number(this.config.get('NOTIFY_ARRIVAL_AHEAD', 1));
  }

  onModuleInit(): void {
    // subscribe as a second consumer; fire-and-forget per event (errors logged)
    this.unsubscribe = this.events.onSessionChanged((session) => {
      void this.onQueueEvent(session).catch((err) =>
        this.logger.error(`notification scan failed: ${(err as Error).message}`),
      );
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private sessionTag(s: SessionKey): string {
    return `${s.doctorId}:${s.sessionDate}:${s.sessionType}`;
  }

  /** Per-session-per-type set of bookings already notified (idempotency gate). */
  private flagKey(type: NotificationType, s: SessionKey): string {
    return `pfos:notif:${type}:${this.sessionTag(s)}`;
  }

  /**
   * Booking Confirmed — fires once on successful payment confirmation. Called
   * directly from the payments confirm handler (not a queue mutation).
   */
  async bookingConfirmed(bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { patient: { select: { fcmToken: true } } },
    });
    if (!booking?.tokenNumber) return;
    const session: SessionKey = {
      doctorId: booking.doctorId,
      sessionDate: booking.sessionDate.toISOString().slice(0, 10),
      sessionType: booking.sessionType,
    };
    await this.deliverOnce(
      NotificationType.BOOKING_CONFIRMED,
      session,
      bookingId, // member: booking id (token is enough too, but confirm is per-booking)
      booking.patient?.fcmToken ?? null,
      booking.tokenNumber,
      {
        title: 'Booking confirmed',
        body: `Your token ${booking.tokenNumber} is confirmed.`,
        data: { type: NotificationType.BOOKING_CONFIRMED, bookingId, token: booking.tokenNumber },
      },
    );
  }

  /**
   * Threshold scan on a queue mutation. Only the front slice up to the larger
   * configured threshold is read — not the whole queue.
   */
  async onQueueEvent(session: SessionKey): Promise<void> {
    const maxAhead = Math.max(this.approachingAhead, this.arrivalAhead);
    // patientsAhead runs 0..maxAhead -> need maxAhead+1 tokens from the front
    const slice = await this.queue.frontSlice(session, maxAhead + 1);

    for (let patientsAhead = 0; patientsAhead < slice.length; patientsAhead++) {
      const token = slice[patientsAhead];
      if (patientsAhead <= this.approachingAhead) {
        await this.fireThreshold(NotificationType.QUEUE_APPROACHING, session, token, patientsAhead);
      }
      if (patientsAhead <= this.arrivalAhead) {
        await this.fireThreshold(NotificationType.ARRIVAL_REMINDER, session, token, patientsAhead);
      }
    }
  }

  private async fireThreshold(
    type: NotificationType,
    session: SessionKey,
    token: string,
    patientsAhead: number,
  ): Promise<void> {
    const bookingId = await this.queue.bookingIdFor(token, session);
    if (!bookingId) return; // raw token with no DB booking — nothing to notify

    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { patient: { select: { fcmToken: true } } },
    });
    const fcm = booking?.patient?.fcmToken ?? null;

    const message: PushMessage =
      type === NotificationType.ARRIVAL_REMINDER
        ? {
            title: 'You are next',
            body: `Token ${token} — please be ready, your turn is coming up.`,
            data: { type, token, bookingId, patientsAhead: String(patientsAhead) },
          }
        : {
            title: 'Your turn is approaching',
            body: `Token ${token} — ${patientsAhead} ahead of you.`,
            data: { type, token, bookingId, patientsAhead: String(patientsAhead) },
          };

    await this.deliverOnce(type, session, token, fcm, token, message);
  }

  /**
   * Deliver exactly once. The Redis SADD is the atomic gate: only the caller
   * that newly adds the member proceeds to send. If there is no device token to
   * push to, the gate is rolled back (SREM) so a later mutation can retry once
   * the patient has registered a device.
   */
  private async deliverOnce(
    type: NotificationType,
    session: SessionKey,
    member: string,
    deviceToken: string | null,
    logToken: string,
    message: PushMessage,
  ): Promise<void> {
    const key = this.flagKey(type, session);
    const added = await this.redisService.redis.sadd(key, member);
    if (added !== 1) return; // already notified -> idempotent no-op

    if (!deviceToken) {
      // no device registered yet — un-gate so it can fire after registration
      await this.redisService.redis.srem(key, member);
      this.logger.debug(`${type} skipped for ${logToken}: no device token`);
      return;
    }

    await this.push.send(deviceToken, message);
  }

  /** Test/teardown helper: clear all idempotency flags for a session. */
  async clearSessionFlags(session: SessionKey): Promise<void> {
    await this.redisService.redis.del(
      this.flagKey(NotificationType.BOOKING_CONFIRMED, session),
      this.flagKey(NotificationType.QUEUE_APPROACHING, session),
      this.flagKey(NotificationType.ARRIVAL_REMINDER, session),
    );
  }
}
