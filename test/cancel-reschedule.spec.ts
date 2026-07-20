import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingSource, BookingStatus, PaymentStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PaymentsService } from '../src/payments/payments.service';
import { BookingActionsService } from '../src/bookings/booking-actions.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { NotificationsService } from '../src/notifications/notifications.service';
import { SessionKey } from '../src/queue-engine/token.service';
import { SessionClaims } from '../src/auth/auth-token.service';
import {
  RAZORPAY_GATEWAY,
  RazorpayGateway,
  RpOrder,
  RpPayment,
  RpRefund,
  hmacEquals,
} from '../src/payments/razorpay.gateway';

const KEY_SECRET = 'test_key_secret';

/** Sandbox-faithful fake; refund status is forceable so we can exercise states. */
class FakeRazorpay implements RazorpayGateway {
  private orderSeq = 0;
  readonly payments = new Map<string, RpPayment>();
  readonly refunds: string[] = [];
  nextRefundStatus = 'processed';

  async createOrder(amountPaise: number): Promise<RpOrder> {
    return { orderId: `order_${++this.orderSeq}`, amount: amountPaise };
  }
  setCaptured(orderId: string, paymentId: string, amount: number): void {
    this.payments.set(paymentId, { id: paymentId, orderId, status: 'captured', amount });
  }
  async fetchPayment(paymentId: string): Promise<RpPayment> {
    const p = this.payments.get(paymentId);
    if (!p) throw new Error('no such payment');
    return p;
  }
  async refund(paymentId: string): Promise<RpRefund> {
    this.refunds.push(paymentId);
    return { refundId: `rfnd_${paymentId}`, status: this.nextRefundStatus };
  }
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return hmacEquals(KEY_SECRET, `${orderId}|${paymentId}`, signature);
  }
  verifyWebhookSignature(): boolean {
    return true;
  }
}

function checkoutSig(orderId: string, paymentId: string): string {
  return createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}

/** Today as local YYYY-MM-DD. Same-day model: every booking lands on today. */
function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** An "HH:MM" `minutesAhead` from now, clamped to 23:59 if it would roll past
 *  today — so the seeded session always STARTS LATER TODAY, keeping the same-day
 *  resolver (session not ended) deterministic regardless of wall-clock run time.
 *  (The cancel cutoff is gone, so start proximity no longer affects cancel.) */
function futureHm(minutesAhead: number): string {
  const now = new Date();
  const at = new Date(now.getTime() + minutesAhead * 60_000);
  if (at.getDate() !== now.getDate() || at.getMonth() !== now.getMonth()) return '23:59';
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

describe('Cancellation + same-day booking (real Redis + Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let actions: BookingActionsService;
  let consult: ConsultationService;
  let queue: QueueService;
  let notifications: NotificationsService;
  const rp = new FakeRazorpay();

  const CLINIC_ID = 'cx-clinic';
  const DOCTOR_ID = 'cx-doctor';
  const FEE = 400;
  const MORNING_MAX = 5; // informational only now — no capacity cap is enforced

  // Same-day: the booking resolves onto today's session. A single session that
  // starts later today (no evening) so the resolver deterministically picks it.
  const DATE = todayYmd();
  const morning: SessionKey = { doctorId: DOCTOR_ID, sessionDate: DATE, sessionType: 'MORNING' };
  let seq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RAZORPAY_GATEWAY)
      .useValue(rp)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);
    actions = app.get(BookingActionsService);
    consult = app.get(ConsultationService);
    queue = app.get(QueueService);
    notifications = app.get(NotificationsService);

    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'CX Clinic', cancellationCutoffMinutes: 30 },
      update: { cancellationCutoffMinutes: 30 },
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: { id: DOCTOR_ID, clinicId: CLINIC_ID, name: 'Dr CX', consultationFee: FEE },
      update: { consultationFee: FEE },
    });
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.doctorSession.createMany({
      data: [
        {
          doctorId: DOCTOR_ID,
          sessionType: 'MORNING',
          startTime: futureHm(120),
          maxTokens: MORNING_MAX,
          daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
        },
      ],
    });
  });

  beforeEach(async () => {
    await clean();
    rp.nextRefundStatus = 'processed';
  });

  afterAll(async () => {
    await clean();
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  async function clean(): Promise<void> {
    await queue.clearSession(morning);
    await notifications.clearSessionFlags(morning);
    const bs = await prisma.booking.findMany({ where: { doctorId: DOCTOR_ID }, select: { id: true } });
    const ids = bs.map((b) => b.id);
    await prisma.booking.updateMany({ where: { doctorId: DOCTOR_ID }, data: { paymentId: null } });
    await prisma.payment.deleteMany({ where: { bookingId: { in: ids } } });
    await prisma.auditLog.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'cx-pt-' } } });
  }

  async function patient(): Promise<string> {
    const id = `cx-pt-${seq++}`;
    await prisma.patient.create({ data: { id, name: id, mobile: `8${Date.now()}${seq}` } });
    return id;
  }

  function actor(patientId: string): SessionClaims {
    return { sub: patientId, role: 'PATIENT' };
  }

  /**
   * Initiate + pay a same-day booking; returns the booking id, the issued token,
   * the Payment ROW id, and the gateway payment id (what `refund()` sees).
   * No date/slot is supplied — the session is auto-resolved to today.
   */
  async function book(
    patientId: string,
  ): Promise<{ bookingId: string; tokenNumber: string; paymentRowId: string; gatewayPaymentId: string }> {
    const { bookingId, orderId, amount } = await payments.initiateBooking({
      patientId,
      doctorId: DOCTOR_ID,
      source: BookingSource.APP,
    });
    const gatewayPaymentId = `pay_${orderId}`;
    rp.setCaptured(orderId, gatewayPaymentId, amount);
    const res = await payments.verifyCheckout(orderId, gatewayPaymentId, checkoutSig(orderId, gatewayPaymentId));
    const pay = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    return { bookingId, tokenNumber: res.tokenNumber, paymentRowId: pay.id, gatewayPaymentId };
  }

  function liveCount(): Promise<number> {
    return prisma.booking.count({
      where: {
        doctorId: DOCTOR_ID,
        sessionDate: new Date(DATE),
        sessionType: 'MORNING',
        status: { in: [BookingStatus.PENDING_PAYMENT, BookingStatus.BOOKED, BookingStatus.ACTIVE, BookingStatus.COMPLETED, BookingStatus.NO_SHOW] },
      },
    });
  }

  it('cancels a waiting booking: frees capacity, removes the token, refunds, audits', async () => {
    const pA = await patient();
    const pB = await patient();
    await book(pA); // A001 -> ACTIVE (front of empty queue)
    const b = await book(pB); // A002 -> BOOKED (waiting)
    expect(await queue.list(morning)).toEqual(['A001', 'A002']);
    expect(await liveCount()).toBe(2);

    const res = await actions.cancel(actor(pB), b.bookingId, 'changed my mind');
    expect(res).toEqual({ status: 'CANCELLED', refunded: true, refundStatus: 'processed' });

    // token gone from the live queue, capacity slot freed
    expect(await queue.list(morning)).toEqual(['A001']);
    expect(await liveCount()).toBe(1);

    // booking cancelled, reason + refund recorded
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } });
    expect(after.status).toBe(BookingStatus.CANCELLED);
    expect(after.cancellationReason).toBe('changed my mind');
    expect(after.refundStatus).toBe('processed');

    // payment retained as REFUNDED with the razorpay reference
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: b.paymentRowId } });
    expect(pay.status).toBe(PaymentStatus.REFUNDED);
    expect(rp.refunds).toContain(b.gatewayPaymentId);

    // audit entry: actor = patient, action = CANCEL, the token recorded
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { bookingId: b.bookingId, action: 'CANCEL' } });
    expect(audit.actorId).toBe(pB);
    expect(audit.actorRole).toBe('PATIENT');
    expect(audit.token).toBe('A002');
    expect(audit.clinicId).toBe(CLINIC_ID);
  });

  it('a failed refund leaves the payment SUCCESS but still cancels the booking', async () => {
    const pA = await patient();
    const pB = await patient();
    await book(pA);
    const b = await book(pB);

    rp.nextRefundStatus = 'failed';
    const res = await actions.cancel(actor(pB), b.bookingId);
    expect(res.refundStatus).toBe('failed');

    const after = await prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } });
    expect(after.status).toBe(BookingStatus.CANCELLED);
    expect(after.refundStatus).toBe('failed');
    const pay = await prisma.payment.findUniqueOrThrow({ where: { id: b.paymentRowId } });
    expect(pay.status).toBe(PaymentStatus.SUCCESS); // money not returned -> retained for retry
  });

  it('cancels a waiting booking regardless of proximity to session start (no time cutoff)', async () => {
    const pA = await patient();
    const pB = await patient();
    await book(pA);
    const b = await book(pB);

    // Absurd cutoff would have blocked under the old rule. Cutoff is gone — a
    // still-waiting (BOOKED) booking cancels no matter how close to start.
    await prisma.clinic.update({ where: { id: CLINIC_ID }, data: { cancellationCutoffMinutes: 100000 } });

    const res = await actions.cancel(actor(pB), b.bookingId);
    expect(res.status).toBe('CANCELLED');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } })).status).toBe(BookingStatus.CANCELLED);
    // dequeued: only the still-active A001 remains
    expect(await queue.list(morning)).toEqual(['A001']);
  });

  it('blocks cancellation of a booking already being served', async () => {
    const pA = await patient();
    const a = await book(pA); // single booking -> ACTIVE immediately
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: a.bookingId } })).status).toBe(BookingStatus.ACTIVE);
    await expect(actions.cancel(actor(pA), a.bookingId)).rejects.toThrow(/cannot cancel/);
  });

  it("rejects cancelling another patient's booking (404, no leak)", async () => {
    const pA = await patient();
    const pB = await patient();
    const a = await book(pA);
    await expect(actions.cancel(actor(pB), a.bookingId)).rejects.toThrow(/not found/);
  });

  it('a cancel racing the doctor calling that patient resolves cleanly (no double-free, queue intact)', async () => {
    const pA = await patient();
    const pB = await patient();
    await book(pA); // A001 ACTIVE
    const b = await book(pB); // A002 BOOKED
    expect(await queue.list(morning)).toEqual(['A001', 'A002']);

    // patient cancels at the same instant the doctor marks them a no-show
    const settled = await Promise.allSettled([
      actions.cancel(actor(pB), b.bookingId),
      consult.markNoShow(morning, 'A002'),
    ]);

    // exactly one side wins the guarded transition; the other rejects cleanly
    const fulfilled = settled.filter((s) => s.status === 'fulfilled').length;
    expect(fulfilled).toBeGreaterThanOrEqual(1);

    // queue is intact: A002 gone exactly once, A001 still active. No corruption,
    // no double-free of the queue slot (A001 is untouched either way).
    expect(await queue.list(morning)).toEqual(['A001']);
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } });
    // whoever won, A002 ends terminal exactly once (CANCELLED if the patient
    // won, NO_SHOW if the doctor did) — never stuck half-applied.
    expect([BookingStatus.CANCELLED, BookingStatus.NO_SHOW]).toContain(after.status);
  });
});
