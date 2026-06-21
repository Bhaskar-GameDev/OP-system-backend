import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Booking, BookingStatus, Payment } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';

/** Terminal booking states eligible for archival (CANCELLED covers refunded). */
const TERMINAL: BookingStatus[] = [
  BookingStatus.COMPLETED,
  BookingStatus.NO_SHOW,
  BookingStatus.CANCELLED,
];

type BookingWithRelations = Booking & {
  payment: Payment | null;
  doctor: { clinicId: string };
};

/**
 * Step 7 — Historical archival. A DECOUPLED scheduled sweep, NOT inline logic in
 * the DONE/no-show/cancel handlers (those are done + tested; untouched here).
 *
 * Each booking's move is one atomic transaction: append the full record to the
 * append-only booking_history, then delete it from the live bookings table. A
 * failure rolls the whole move back — a booking is never in both tables nor
 * missing from both. booking_history has no update/delete path anywhere outside
 * this create (HA-3).
 */
@Injectable()
export class ArchivalService {
  private readonly logger = new Logger(ArchivalService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Start of the current LOCAL day — the "settled before today" boundary.
   * INTENTIONALLY local (not UTC, unlike AnalyticsService.startOfDay): this
   * bounds createdAt, a full timestamp, against the operator's local day. The
   * analytics job bounds a @db.Date column and so uses UTC. Do NOT "align"
   * these two — different boundary purposes, different correct answers.
   */
  private startOfToday(now = new Date()): Date {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }

  /** Daily sweep. Runs off the active request path entirely. */
  @Cron(CronExpression.EVERY_DAY_AT_2AM, { name: 'booking-archival' })
  async scheduledSweep(): Promise<void> {
    const { archived } = await this.runSweep();
    if (archived > 0) this.logger.log(`archived ${archived} settled booking(s)`);
  }

  /**
   * Sweep all terminal bookings settled before today into history. Same-day
   * terminal bookings are intentionally left for the next sweep. Each booking
   * is moved in its own transaction, so a mid-batch failure leaves the already
   * moved ones consistent and the rest untouched.
   */
  async runSweep(now = new Date()): Promise<{ archived: number }> {
    const cutoff = this.startOfToday(now);
    // createdAt is the universal "settled" cutoff: consultation_ended_at is null
    // for NO_SHOW/CANCELLED, so it can't serve as a cross-status boundary.
    const due = await this.prisma.booking.findMany({
      where: { status: { in: TERMINAL }, createdAt: { lt: cutoff } },
      include: { payment: true, doctor: { select: { clinicId: true } } },
      orderBy: { createdAt: 'asc' },
    });

    let archived = 0;
    for (const booking of due) {
      await this.archiveOne(booking);
      archived++;
    }
    return { archived };
  }

  /** Move ONE booking atomically: append to history, then delete from bookings. */
  async archiveOne(booking: BookingWithRelations): Promise<void> {
    const payment = booking.payment;
    await this.prisma.$transaction(async (tx) => {
      await tx.bookingHistory.create({
        data: {
          bookingId: booking.id,
          patientId: booking.patientId,
          doctorId: booking.doctorId,
          clinicId: booking.doctor.clinicId,
          source: booking.source,
          tokenNumber: booking.tokenNumber,
          sessionDate: booking.sessionDate,
          sessionType: booking.sessionType,
          finalStatus: booking.status,
          paymentAmount: payment?.amount ?? null,
          paymentStatus: payment?.status ?? null,
          paymentRef:
            payment?.razorpayPaymentId ??
            payment?.razorpayRefundId ??
            payment?.gatewayRef ??
            null,
          bookedAt: booking.createdAt,
          consultationStartedAt: booking.consultationStartedAt,
          consultationEndedAt: booking.consultationEndedAt,
        },
      });
      // delete only from bookings — the payment row is retained as the financial
      // ledger (consistent with the REFUNDED-retention decision in Step 5).
      await tx.booking.delete({ where: { id: booking.id } });
    });
  }
}
