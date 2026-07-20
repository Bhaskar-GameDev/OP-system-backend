import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { BookingSource, BookingStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConsultationService } from '../queue-engine/consultation.service';
import { SessionKey, TokenSource } from '../queue-engine/token.service';
import { NotificationsService } from '../notifications/notifications.service';
import { SessionResolverService } from '../bookings/session-resolver.service';
import {
  RAZORPAY_GATEWAY,
  RazorpayGateway,
} from './razorpay.gateway';

const SOURCE_TO_TOKEN: Record<BookingSource, TokenSource> = {
  [BookingSource.APP]: TokenSource.APP,
  [BookingSource.WALK_IN]: TokenSource.WALK_IN,
  [BookingSource.VOICE]: TokenSource.VOICE,
};

// Same-day model: the patient supplies only a doctor. The session (date + type)
// is auto-resolved to today's next-starting, not-yet-ended session — no date or
// slot picker, no capacity cap.
export interface InitiateBookingInput {
  patientId: string;
  doctorId: string;
  source: BookingSource;
}

export interface ConfirmResult {
  bookingId: string;
  tokenNumber: string;
  alreadyProcessed: boolean; // true if a prior path already issued the token
}

@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly consult: ConsultationService,
    private readonly notifications: NotificationsService,
    private readonly sessionResolver: SessionResolverService,
    @Inject(RAZORPAY_GATEWAY) private readonly razorpay: RazorpayGateway,
  ) {}

  private sessionOf(booking: {
    doctorId: string;
    sessionDate: Date;
    sessionType: string;
  }): SessionKey {
    return {
      doctorId: booking.doctorId,
      sessionDate: booking.sessionDate.toISOString().slice(0, 10),
      sessionType: booking.sessionType,
    };
  }

  /**
   * Start a booking: create the PENDING_PAYMENT booking (NO token yet) + a
   * Razorpay order. The client pays against the returned orderId.
   *
   * Same-day model: there is NO date/slot selection and NO capacity cap. We
   * auto-resolve today's next-starting, not-yet-ended session for the doctor.
   * If the doctor has no joinable session left today the booking is rejected —
   * we never silently roll to tomorrow. Fee is that session's existing fee.
   */
  async initiateBooking(input: InitiateBookingInput): Promise<{
    bookingId: string;
    orderId: string;
    amount: number;
  }> {
    // resolveToday throws NotFound if the doctor doesn't exist.
    const resolved = await this.sessionResolver.resolveToday(input.doctorId);
    if (resolved.status !== 'OPEN') {
      throw new ConflictException(
        resolved.reason === 'NOT_SCHEDULED'
          ? 'this doctor has no sessions today'
          : 'no more sessions today',
      );
    }
    const { sessionDate, sessionType, fee } = resolved.session;

    const amountPaise = fee * 100;

    const booking = await this.prisma.booking.create({
      data: {
        patientId: input.patientId,
        doctorId: input.doctorId,
        source: input.source,
        sessionDate: new Date(sessionDate),
        sessionType,
        status: BookingStatus.PENDING_PAYMENT,
      },
    });

    const order = await this.razorpay.createOrder(amountPaise, booking.id);

    const payment = await this.prisma.payment.create({
      data: {
        bookingId: booking.id,
        amount: amountPaise,
        status: PaymentStatus.CREATED,
        razorpayOrderId: order.orderId,
      },
    });
    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { paymentId: payment.id },
    });

    return { bookingId: booking.id, orderId: order.orderId, amount: amountPaise };
  }

  // ── entry path (a): webhook ──────────────────────────────
  /**
   * Razorpay webhook. Verifies the signature on the RAW body first (spoofed /
   * unsigned -> 401), then dispatches by event:
   *  - payment.failed -> expire the booking + release any token (idempotent)
   *  - otherwise (payment.captured / authorized) -> confirm (idempotent)
   */
  async handleWebhook(rawBody: string, signature: string): Promise<void> {
    if (!this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException('invalid webhook signature');
    }
    const event = JSON.parse(rawBody) as {
      event: string;
      payload?: { payment?: { entity?: { id: string; order_id: string } } };
    };
    const entity = event.payload?.payment?.entity;
    if (!entity?.order_id) return; // not a payment event we act on

    if (event.event === 'payment.failed') {
      await this.handlePaymentFailed(entity.order_id, entity.id ?? null);
      return;
    }
    if (!entity.id) return;
    await this.confirm(entity.order_id, entity.id);
  }

  /**
   * Handle a Razorpay payment.failed event. Marks the payment FAILED and the
   * booking EXPIRED, releases any queue token, and pushes a "rebook" notice.
   *
   * Idempotent: a booking already confirmed (payment SUCCESS) or already failed
   * (payment FAILED) is left untouched — we log a warning and return so the
   * caller still answers the webhook with 200.
   */
  async handlePaymentFailed(orderId: string, paymentId: string | null): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { razorpayOrderId: orderId },
      include: { booking: true },
    });
    if (!payment || !payment.booking) {
      this.logger.warn(`payment.failed for unknown order ${orderId} — ignored`);
      return;
    }
    if (payment.status === PaymentStatus.SUCCESS) {
      this.logger.warn(`payment.failed for already-confirmed order ${orderId} — ignored`);
      return;
    }
    if (payment.status === PaymentStatus.FAILED) {
      this.logger.warn(`payment.failed for already-failed order ${orderId} — ignored`);
      return;
    }

    // atomic guard: only the caller that flips CREATED -> FAILED proceeds
    const flipped = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.CREATED },
      data: { status: PaymentStatus.FAILED, razorpayPaymentId: paymentId ?? undefined },
    });
    if (flipped.count === 0) {
      this.logger.warn(`payment.failed lost the race for order ${orderId} — ignored`);
      return;
    }

    await this.expireBooking(payment.booking, 'payment.failed webhook');
  }

  /**
   * Sweep PENDING_PAYMENT bookings older than the cutoff and expire them — the
   * safety net for webhooks that never arrive. Each booking is flipped under a
   * guarded updateMany so a concurrent confirm always wins. Returns the count
   * expired. Called by the scheduled cleanup task.
   */
  async expireStalePending(olderThanMinutes = 30): Promise<{ expired: number }> {
    const cutoff = new Date(Date.now() - olderThanMinutes * 60_000);
    const stale = await this.prisma.booking.findMany({
      where: { status: BookingStatus.PENDING_PAYMENT, createdAt: { lt: cutoff } },
      include: { payment: true },
    });

    let expired = 0;
    for (const booking of stale) {
      // guarded transition — skip if a confirm flipped it since the read
      const flipped = await this.prisma.booking.updateMany({
        where: { id: booking.id, status: BookingStatus.PENDING_PAYMENT },
        data: { status: BookingStatus.EXPIRED },
      });
      if (flipped.count === 0) continue;

      if (booking.payment && booking.payment.status === PaymentStatus.CREATED) {
        await this.prisma.payment.updateMany({
          where: { id: booking.payment.id, status: PaymentStatus.CREATED },
          data: { status: PaymentStatus.FAILED },
        });
      }
      await this.releaseToken(booking);
      await this.notifications.paymentFailed(booking.id);
      expired += 1;
    }

    if (expired > 0) {
      this.logger.warn(`expired ${expired} stale pending-payment booking(s) (> ${olderThanMinutes}m)`);
    }
    return { expired };
  }

  /**
   * Move a booking to EXPIRED: release any live token, then notify. Assumes the
   * caller already won the status guard (payment flip or booking flip).
   */
  private async expireBooking(
    booking: { id: string; doctorId: string; sessionDate: Date; sessionType: string; tokenNumber: string | null },
    reason: string,
  ): Promise<void> {
    await this.releaseToken(booking);
    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { status: BookingStatus.EXPIRED },
    });
    await this.notifications.paymentFailed(booking.id);
    this.logger.warn(`booking ${booking.id} marked EXPIRED (${reason})`);
  }

  /** Pull a booking's token from the live queue, if it has one (usually none). */
  private async releaseToken(booking: {
    doctorId: string;
    sessionDate: Date;
    sessionType: string;
    tokenNumber: string | null;
  }): Promise<void> {
    if (booking.tokenNumber) {
      await this.consult.cancelDequeue(this.sessionOf(booking), booking.tokenNumber);
    }
  }

  // ── entry path (b): synchronous checkout verification ────
  /** Client returned from checkout. Verifies the checkout signature, then confirms. */
  async verifyCheckout(
    orderId: string,
    paymentId: string,
    signature: string,
  ): Promise<ConfirmResult> {
    if (!this.razorpay.verifyCheckoutSignature(orderId, paymentId, signature)) {
      throw new UnauthorizedException('invalid payment signature');
    }
    return this.confirm(orderId, paymentId);
  }

  /**
   * THE single idempotent confirmation handler. Both paths funnel here.
   *
   * Truth = Razorpay (fetchPayment); never a client-supplied success flag.
   * Dedup = a guarded status transition (CREATED -> SUCCESS) that exactly one
   * caller wins; the loser is a no-op returning the already-issued token.
   * Token issuance reuses the Queue Engine's enqueueBooking — no duplication.
   */
  async confirm(orderId: string, paymentId: string): Promise<ConfirmResult> {
    const payment = await this.prisma.payment.findUnique({
      where: { razorpayOrderId: orderId },
      include: { booking: true },
    });
    if (!payment || !payment.booking) {
      throw new NotFoundException('no booking for this order');
    }

    // already confirmed by either path -> idempotent no-op
    if (payment.status === PaymentStatus.SUCCESS) {
      return {
        bookingId: payment.booking.id,
        tokenNumber: payment.booking.tokenNumber ?? '',
        alreadyProcessed: true,
      };
    }

    // authoritative status from Razorpay
    const rp = await this.razorpay.fetchPayment(paymentId);
    if (rp.orderId !== orderId) {
      throw new BadRequestException('payment does not match order');
    }
    if (rp.status !== 'captured') {
      // not a success: leave booking PENDING; record the failure, no token
      await this.prisma.payment.updateMany({
        where: { id: payment.id, status: PaymentStatus.CREATED },
        data: { status: PaymentStatus.FAILED, razorpayPaymentId: paymentId },
      });
      throw new ConflictException(`payment not captured (status: ${rp.status})`);
    }

    // atomic win-or-noop: only one path flips CREATED -> SUCCESS
    const flipped = await this.prisma.payment.updateMany({
      where: { id: payment.id, status: PaymentStatus.CREATED },
      data: {
        status: PaymentStatus.SUCCESS,
        razorpayPaymentId: paymentId,
        gatewayRef: paymentId,
      },
    });
    if (flipped.count === 0) {
      // another path won the race; return its result
      const fresh = await this.prisma.booking.findUniqueOrThrow({
        where: { id: payment.booking.id },
      });
      return {
        bookingId: fresh.id,
        tokenNumber: fresh.tokenNumber ?? '',
        alreadyProcessed: true,
      };
    }

    // WE won: issue the token via the existing Queue Engine path
    const booking = payment.booking;
    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { status: BookingStatus.BOOKED }, // must be BOOKED before enqueue (promote guard)
    });

    const session = this.sessionOf(booking);
    const entry = await this.consult.enqueueBooking(
      SOURCE_TO_TOKEN[booking.source],
      session,
      booking.id,
    );
    await this.prisma.booking.update({
      where: { id: booking.id },
      data: { tokenNumber: entry.tokenNumber },
    });

    // Booking Confirmed push — fires once, only on the path that issued the token.
    await this.notifications.bookingConfirmed(booking.id);

    return {
      bookingId: booking.id,
      tokenNumber: entry.tokenNumber,
      alreadyProcessed: false,
    };
  }

  /**
   * Cancel a booking. Allowed ONLY from PENDING_PAYMENT or BOOKED — never
   * ACTIVE/COMPLETED. The booking-status flip is a GUARDED transition so a
   * cancel racing the doctor calling that same patient can never both win
   * (no double-free of the slot, no corrupted queue): exactly one of them
   * flips the row. After winning the flip we remove any live token from the
   * Redis queue (same lock + primitive as no-show), then refund a captured
   * payment and record its settle state (processed | pending | failed). A
   * failed refund leaves the payment SUCCESS so staff can retry; a
   * processed/pending refund flips it to REFUNDED with the Razorpay reference.
   */
  async cancelBooking(
    bookingId: string,
    opts: { reason?: string } = {},
  ): Promise<{ refunded: boolean; refundStatus: string | null; refundId: string | null }> {
    const booking = await this.prisma.booking.findUnique({
      where: { id: bookingId },
      include: { payment: true },
    });
    if (!booking) throw new NotFoundException('booking not found');

    if (
      booking.status !== BookingStatus.PENDING_PAYMENT &&
      booking.status !== BookingStatus.BOOKED
    ) {
      throw new ConflictException(
        `cannot cancel a ${booking.status} booking`,
      );
    }

    // Atomically claim the cancellation: only the caller that flips a still-
    // cancellable row proceeds. If the doctor (or another request) moved it
    // since our read, this is a no-op and we reject cleanly.
    const claimed = await this.prisma.booking.updateMany({
      where: {
        id: bookingId,
        status: { in: [BookingStatus.PENDING_PAYMENT, BookingStatus.BOOKED] },
      },
      data: {
        status: BookingStatus.CANCELLED,
        cancellationReason: opts.reason ?? null,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException('booking is no longer cancellable');
    }

    // pull any live token from the queue (no ghost token). GONE-safe: if the
    // doctor already removed it, this is a no-op.
    if (booking.tokenNumber) {
      await this.consult.cancelDequeue(this.sessionOf(booking), booking.tokenNumber);
    }

    // refund a captured payment, keeping the Razorpay refund reference + state
    let refunded = false;
    let refundId: string | null = null;
    let refundStatus: string | null = null;
    const payment = booking.payment;
    if (payment?.status === PaymentStatus.SUCCESS && payment.razorpayPaymentId) {
      const refund = await this.razorpay.refund(payment.razorpayPaymentId);
      refundId = refund.refundId;
      refundStatus = refund.status;
      refunded = true;

      // processed/pending -> money is on its way back: retain the payment row,
      // flip to REFUNDED with the ref. failed -> leave it SUCCESS for retry.
      if (refund.status !== 'failed') {
        await this.prisma.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.REFUNDED, razorpayRefundId: refundId },
        });
      }
    }

    await this.prisma.booking.update({
      where: { id: bookingId },
      data: { refundStatus },
    });

    return { refunded, refundStatus, refundId };
  }
}
