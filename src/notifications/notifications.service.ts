import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PushPlatform } from '@prisma/client';
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
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  BOOKING_CANCELLED = 'BOOKING_CANCELLED',
}

/**
 * firebase-admin error codes that mean the stored device token is dead. When we
 * hit one we clear the patient's token so a later send doesn't keep failing and
 * the app re-registers a fresh one on next open.
 */
const STALE_TOKEN_CODES = new Set([
  'messaging/registration-token-not-registered',
  'messaging/invalid-registration-token',
  'messaging/invalid-argument',
]);

/**
 * NOTE: these are FCM-level codes, returned the same way whether FCM ended up
 * delivering via APNs (iOS) or directly (Android), so the set covers both.
 *
 * `messaging/third-party-auth-error` is deliberately NOT here. FCM returns it
 * for an iOS token when the APNs key is missing or wrong in the Firebase
 * project — a server misconfiguration, not a dead device. Clearing the token on
 * it would make every iOS device re-register in a loop while hiding the actual
 * cause.
 */

/** Where to push for one patient: the token, plus the platform that issued it. */
type PatientDevice = {
  fcmToken: string | null;
  pushPlatform: PushPlatform | null;
};

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
      include: { patient: { select: { fcmToken: true, pushPlatform: true } } },
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
      booking.patient ?? null,
      booking.patientId,
      booking.tokenNumber,
      {
        title: 'Booking confirmed',
        body: `Your token ${booking.tokenNumber} is confirmed.`,
        data: {
          type: NotificationType.BOOKING_CONFIRMED,
          bookingId,
          token: booking.tokenNumber,
          doctorId: session.doctorId,
          sessionDate: session.sessionDate,
          sessionType: session.sessionType,
        },
      },
    );
  }

  /**
   * Payment Failed — fires once when a booking is expired (failed payment or the
   * pending-payment timeout sweep). Tells the patient they can rebook. The
   * booking has no token; the session is only used to key the idempotency set.
   * Best-effort: deliverOnce swallows send errors so this never breaks the
   * payments flow that called it.
   */
  async paymentFailed(bookingId: string): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { patient: { select: { fcmToken: true, pushPlatform: true } } },
    });
    if (!booking) return;
    const session: SessionKey = {
      doctorId: booking.doctorId,
      sessionDate: booking.sessionDate.toISOString().slice(0, 10),
      sessionType: booking.sessionType,
    };
    await this.deliverOnce(
      NotificationType.PAYMENT_FAILED,
      session,
      bookingId,
      booking.patient ?? null,
      booking.patientId,
      bookingId,
      {
        title: 'Payment failed',
        body: 'Your payment did not go through, so your booking was not confirmed. You can try booking again.',
        data: {
          type: NotificationType.PAYMENT_FAILED,
          bookingId,
          doctorId: session.doctorId,
          sessionDate: session.sessionDate,
          sessionType: session.sessionType,
        },
      },
    );
  }

  /**
   * Booking Cancelled — fires once when a patient cancels their booking.
   * Confirms the cancellation and, when a refund was triggered, its state
   * (processed / pending / failed). Called directly from the cancel flow.
   */
  async bookingCancelled(bookingId: string, refundStatus: string | null): Promise<void> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { patient: { select: { fcmToken: true, pushPlatform: true } } },
    });
    if (!booking) return;
    const session: SessionKey = {
      doctorId: booking.doctorId,
      sessionDate: booking.sessionDate.toISOString().slice(0, 10),
      sessionType: booking.sessionType,
    };
    const refundLine =
      refundStatus === 'processed'
        ? ' Your refund has been processed.'
        : refundStatus === 'pending'
          ? ' Your refund is being processed.'
          : refundStatus === 'failed'
            ? ' Your refund could not be processed — our team will follow up.'
            : '';
    await this.deliverOnce(
      NotificationType.BOOKING_CANCELLED,
      session,
      bookingId,
      booking.patient ?? null,
      booking.patientId,
      booking.tokenNumber ?? bookingId,
      {
        title: 'Booking cancelled',
        body: `Your booking has been cancelled.${refundLine}`,
        data: {
          type: NotificationType.BOOKING_CANCELLED,
          bookingId,
          refundStatus: refundStatus ?? '',
          doctorId: session.doctorId,
          sessionDate: session.sessionDate,
          sessionType: session.sessionType,
        },
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
      include: { patient: { select: { fcmToken: true, pushPlatform: true } } },
    });
    const device = booking?.patient ?? null;

    const message: PushMessage =
      type === NotificationType.ARRIVAL_REMINDER
        ? {
            title: 'You are next',
            body: `Token ${token} — please be ready, your turn is coming up.`,
            data: {
              type,
              token,
              bookingId,
              patientsAhead: String(patientsAhead),
              doctorId: session.doctorId,
              sessionDate: session.sessionDate,
              sessionType: session.sessionType,
            },
          }
        : {
            title: 'Your turn is approaching',
            body: `Token ${token} — ${patientsAhead} ahead of you.`,
            data: {
              type,
              token,
              bookingId,
              patientsAhead: String(patientsAhead),
              doctorId: session.doctorId,
              sessionDate: session.sessionDate,
              sessionType: session.sessionType,
            },
          };

    await this.deliverOnce(type, session, token, device, booking?.patientId ?? null, token, message);
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
    device: PatientDevice | null,
    patientId: string | null,
    logToken: string,
    message: PushMessage,
  ): Promise<void> {
    const key = this.flagKey(type, session);
    const added = await this.redisService.redis.sadd(key, member);
    if (added !== 1) return; // already notified -> idempotent no-op

    const deviceToken = device?.fcmToken ?? null;
    if (!deviceToken) {
      // no device registered yet — un-gate so it can fire after registration
      await this.redisService.redis.srem(key, member);
      this.logger.debug(`${type} skipped for ${logToken}: no device token`);
      return;
    }

    // A push failure must NEVER propagate: bookingConfirmed is awaited inside
    // the payments confirm handler (token already issued), and the threshold
    // path runs off a committed queue mutation. A stale/invalid device token is
    // self-healed by clearing it so future sends stop failing.
    try {
      await this.push.send(deviceToken, message, device?.pushPlatform ?? null);
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      this.logger.error(
        `${type} push failed for ${logToken}: ${(err as Error).message}`,
      );
      if (STALE_TOKEN_CODES.has(code) && patientId) {
        await this.prisma.patient
          .updateMany({
            where: { id: patientId, fcmToken: deviceToken },
            data: { fcmToken: null },
          })
          .then(() =>
            this.logger.warn(`cleared stale FCM token for patient ${patientId}`),
          )
          .catch(() => undefined);
      }
    }
  }

  /** Test/teardown helper: clear all idempotency flags for a session. */
  async clearSessionFlags(session: SessionKey): Promise<void> {
    await this.redisService.redis.del(
      this.flagKey(NotificationType.BOOKING_CONFIRMED, session),
      this.flagKey(NotificationType.QUEUE_APPROACHING, session),
      this.flagKey(NotificationType.ARRIVAL_REMINDER, session),
      this.flagKey(NotificationType.PAYMENT_FAILED, session),
      this.flagKey(NotificationType.BOOKING_CANCELLED, session),
    );
  }
}
