import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { BookingSource, BookingStatus, PaymentStatus } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { ConsultationService } from '../queue-engine/consultation.service';
import { SessionKey, TokenSource } from '../queue-engine/token.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  RAZORPAY_GATEWAY,
  RazorpayGateway,
} from './razorpay.gateway';

const SOURCE_TO_TOKEN: Record<BookingSource, TokenSource> = {
  [BookingSource.APP]: TokenSource.APP,
  [BookingSource.WALK_IN]: TokenSource.WALK_IN,
  [BookingSource.VOICE]: TokenSource.VOICE,
};

export interface InitiateBookingInput {
  patientId: string;
  doctorId: string;
  sessionDate: string; // YYYY-MM-DD
  sessionType: 'MORNING' | 'EVENING';
  source: BookingSource;
}

export interface ConfirmResult {
  bookingId: string;
  tokenNumber: string;
  alreadyProcessed: boolean; // true if a prior path already issued the token
}

@Injectable()
export class PaymentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly consult: ConsultationService,
    private readonly notifications: NotificationsService,
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
   */
  async initiateBooking(input: InitiateBookingInput): Promise<{
    bookingId: string;
    orderId: string;
    amount: number;
  }> {
    const doctor = await this.prisma.doctor.findUnique({
      where: { id: input.doctorId },
      select: { consultationFee: true },
    });
    if (!doctor) throw new NotFoundException('doctor not found');

    const amountPaise = doctor.consultationFee * 100;

    const booking = await this.prisma.booking.create({
      data: {
        patientId: input.patientId,
        doctorId: input.doctorId,
        source: input.source,
        sessionDate: new Date(input.sessionDate),
        sessionType: input.sessionType,
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
  /** Razorpay webhook. Verifies signature on the RAW body, then confirms. */
  async handleWebhook(rawBody: string, signature: string): Promise<void> {
    if (!this.razorpay.verifyWebhookSignature(rawBody, signature)) {
      throw new UnauthorizedException('invalid webhook signature');
    }
    const event = JSON.parse(rawBody) as {
      event: string;
      payload?: { payment?: { entity?: { id: string; order_id: string } } };
    };
    const entity = event.payload?.payment?.entity;
    if (!entity?.id || !entity?.order_id) return; // not a payment event we act on
    await this.confirm(entity.order_id, entity.id);
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
   * ACTIVE/COMPLETED. Removes any live token from the Redis queue first (same
   * primitive as no-show), refunds a successful payment, then transitions the
   * payment to REFUNDED (record retained, with the Razorpay refund reference —
   * full financial audit trail) and marks the booking CANCELLED.
   */
  async cancelBooking(bookingId: string): Promise<{ refunded: boolean }> {
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

    // pull any live token from the queue BEFORE refunding (no ghost token)
    if (booking.tokenNumber) {
      await this.consult.cancelDequeue(this.sessionOf(booking), booking.tokenNumber);
    }

    // refund a captured payment, keeping the Razorpay refund reference
    let refunded = false;
    let refundId: string | null = null;
    const payment = booking.payment;
    if (payment?.status === PaymentStatus.SUCCESS && payment.razorpayPaymentId) {
      const refund = await this.razorpay.refund(payment.razorpayPaymentId);
      refundId = refund.refundId;
      refunded = true;
    }

    // mark cancelled; retain the payment row, flip it to REFUNDED with the ref.
    // (No row deletion — the audit trail is preserved per the Step 5 flag.)
    await this.prisma.$transaction(async (tx) => {
      await tx.booking.update({
        where: { id: bookingId },
        data: { status: BookingStatus.CANCELLED },
      });
      if (payment && refunded) {
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: PaymentStatus.REFUNDED, razorpayRefundId: refundId },
        });
      }
    });

    return { refunded };
  }
}
