import { ConflictException, Injectable } from '@nestjs/common';
import { BookingStatus, Prisma, SessionType } from '@prisma/client';
import { ConfigService } from '@nestjs/config';

/**
 * Per-patient booking limits — abuse protection for the patient-app path.
 *
 * The problem this solves: `initiateBooking` created a booking row BEFORE any
 * payment, with no cap. One authenticated patient could script the endpoint and
 * hold unlimited places across every doctor in a clinic, so the clinic opened to
 * a queue of phantom patients and could not issue tokens to people physically
 * present. That is denial of service against clinical operations.
 *
 * Two rules, chosen to match how this hospital workflow actually behaves rather
 * than a blanket "one booking ever":
 *
 *  RULE A — one live booking per patient per doctor-session.
 *    A patient has no legitimate reason to hold two places in the SAME queue.
 *    This mirrors the guard the voice channel already applies
 *    (VoiceService.book), so both channels behave identically.
 *
 *  RULE B — a daily cap across all doctors (default 3).
 *    Seeing two or three specialists in one visit is normal and must keep
 *    working; booking fifteen is not a patient, it is a script.
 *
 * What does NOT count toward either limit: CANCELLED, EXPIRED, COMPLETED and
 * NO_SHOW. So cancelling genuinely releases capacity, and a patient who
 * completed a consultation this morning can still book again this afternoon.
 *
 * PENDING_PAYMENT DOES count — it is the cheapest row to create (no payment
 * required) and therefore the actual attack surface. The existing payment
 * cleanup sweep expires abandoned ones, so this cannot strand a patient who
 * simply closed the app mid-payment.
 *
 * Reception walk-ins are deliberately NOT limited: staff create those for a
 * patient standing at the desk, and refusing care to a present patient because
 * of an automated cap would be the wrong failure. Staff actions are already
 * authenticated, authorized and audited.
 */
@Injectable()
export class BookingLimitService {
  constructor(private readonly config: ConfigService) {}

  /** Statuses that occupy a real place in a queue. */
  static readonly LIVE_STATUSES: BookingStatus[] = [
    BookingStatus.PENDING_PAYMENT,
    BookingStatus.BOOKED,
    BookingStatus.ACTIVE,
  ];

  /** Max live bookings one patient may hold across all doctors on one day. */
  get maxLivePerDay(): number {
    return this.config.get<number>('BOOKING_MAX_LIVE_PER_PATIENT_PER_DAY', 3);
  }

  /**
   * Enforce both rules for a patient about to book, then run `create`.
   *
   * Concurrency: the check and the insert run inside ONE transaction guarded by
   * a Postgres transaction-scoped advisory lock keyed on the patient id. Two
   * simultaneous requests for the same patient serialize on that lock, so the
   * classic check-then-act race — both read "0 bookings", both insert — cannot
   * happen. The lock is per-patient, so unrelated patients never contend, and it
   * releases automatically when the transaction ends (including on rollback),
   * so a crashed request cannot wedge an account.
   */
  async withLimitsEnforced<T>(
    tx: Prisma.TransactionClient,
    args: {
      patientId: string;
      doctorId: string;
      sessionDate: Date;
      sessionType: SessionType;
    },
    create: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    // Serialize concurrent booking attempts for THIS patient only.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${args.patientId}, 0))`;

    // RULE A — already in this doctor's queue for this session?
    const sameSession = await tx.booking.findFirst({
      where: {
        patientId: args.patientId,
        doctorId: args.doctorId,
        sessionDate: args.sessionDate,
        sessionType: args.sessionType,
        status: { in: BookingLimitService.LIVE_STATUSES },
      },
      select: { id: true },
    });
    if (sameSession) {
      throw new ConflictException(
        'you already have a booking with this doctor for this session',
      );
    }

    // RULE B — daily cap across doctors.
    const liveToday = await tx.booking.count({
      where: {
        patientId: args.patientId,
        sessionDate: args.sessionDate,
        status: { in: BookingLimitService.LIVE_STATUSES },
      },
    });
    if (liveToday >= this.maxLivePerDay) {
      throw new ConflictException(
        `you already have ${liveToday} active bookings today (limit ${this.maxLivePerDay}). ` +
          'Cancel one before booking again.',
      );
    }

    return create(tx);
  }
}
