import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BookingStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { PaymentsService } from '../payments/payments.service';
import { AuditService } from '../queue-engine/audit.service';
import { SessionClaims } from '../auth/auth-token.service';
import { NotificationsService } from '../notifications/notifications.service';

export interface CancelResult {
  status: 'CANCELLED';
  refunded: boolean;
  refundStatus: string | null;
}

const BOOKING_INCLUDE = {
  doctor: { include: { clinic: true } },
  payment: true,
} satisfies Prisma.BookingInclude;

type BookingWithContext = Prisma.BookingGetPayload<{ include: typeof BOOKING_INCLUDE }>;

/**
 * Patient-initiated cancellation. Orchestrates the existing primitives —
 * PaymentsService (refund/void), AuditService and NotificationsService — and
 * layers on ownership. Eligibility is purely the status gate: any booking still
 * BOOKED (waiting, not yet called) can be cancelled. The old time-based cutoff
 * was removed with same-day booking — a patient joining close to session start
 * could otherwise never self-cancel.
 *
 * Reschedule was removed when booking became same-day-only: with no future date
 * to move to, a morning->evening hop reduces to cancel + rejoin, so the endpoint
 * was deprecated rather than rebuilt. Refund, audit and capacity-release are
 * unaffected — they never depended on capacity caps.
 */
@Injectable()
export class BookingActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly payments: PaymentsService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ── Cancel ─────────────────────────────────────────────────────────────
  async cancel(
    actor: SessionClaims,
    bookingId: string,
    reason?: string,
  ): Promise<CancelResult> {
    const booking = await this.loadOwned(actor, bookingId);

    if (
      booking.status !== BookingStatus.PENDING_PAYMENT &&
      booking.status !== BookingStatus.BOOKED
    ) {
      // serving / completed / no-show / already cancelled
      throw new ConflictException(`cannot cancel a ${booking.status} booking`);
    }

    // PaymentsService owns the race-safe status flip + queue removal + refund.
    const res = await this.payments.cancelBooking(bookingId, { reason });

    await this.audit.record(this.auditActor(actor, booking), {
      action: 'CANCEL',
      doctorId: booking.doctorId,
      sessionDate: this.ymd(booking.sessionDate),
      sessionType: booking.sessionType,
      token: booking.tokenNumber ?? undefined,
      bookingId: booking.id,
      metadata: { reason: reason ?? null, refundStatus: res.refundStatus },
    });

    await this.notifications.bookingCancelled(bookingId, res.refundStatus);

    return { status: 'CANCELLED', refunded: res.refunded, refundStatus: res.refundStatus };
  }

  // ── helpers ────────────────────────────────────────────────────────────

  /** Load a booking the caller owns, or 404 (a patient never learns another's
   *  booking exists). */
  private async loadOwned(
    actor: SessionClaims,
    bookingId: string,
  ): Promise<BookingWithContext> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: BOOKING_INCLUDE,
    });
    if (!booking || booking.patientId !== actor.sub) {
      throw new NotFoundException('booking not found');
    }
    return booking;
  }

  /** Audit rows are clinic-scoped; a patient token carries no clinic, so stamp
   *  the booking's clinic so the entry surfaces in that clinic's trail. */
  private auditActor(actor: SessionClaims, booking: BookingWithContext): SessionClaims {
    return { ...actor, clinicId: actor.clinicId ?? booking.doctor.clinicId };
  }

  private ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
  }
}
