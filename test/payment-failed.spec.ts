import { createHmac } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingSource, BookingStatus, PaymentStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PaymentsService } from '../src/payments/payments.service';
import {
  RAZORPAY_GATEWAY,
  RazorpayGateway,
  RpOrder,
  RpPayment,
  RpRefund,
  hmacEquals,
} from '../src/payments/razorpay.gateway';

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';

/** Sandbox-faithful fake — same HMAC + status semantics as the real gateway. */
class FakeRazorpay implements RazorpayGateway {
  private orderSeq = 0;
  readonly payments = new Map<string, RpPayment>();
  async createOrder(amountPaise: number): Promise<RpOrder> {
    // namespaced + random so order ids never collide with other payment specs
    // sharing the DB under parallel runs (razorpay_order_id is unique)
    const orderId = `order_pf_${++this.orderSeq}_${Math.random().toString(36).slice(2, 8)}`;
    return { orderId, amount: amountPaise };
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
    return { refundId: `rfnd_${paymentId}`, status: 'processed' };
  }
  verifyCheckoutSignature(o: string, p: string, s: string): boolean {
    return hmacEquals(KEY_SECRET, `${o}|${p}`, s);
  }
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return hmacEquals(WEBHOOK_SECRET, rawBody, signature);
  }
}

function failedWebhook(orderId: string, paymentId: string): { raw: string; sig: string } {
  const raw = JSON.stringify({
    event: 'payment.failed',
    payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
  });
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return { raw, sig };
}

describe('Payment failure webhook + pending-payment cleanup (real Redis + Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  const rp = new FakeRazorpay();

  const CLINIC_ID = 'pf-clinic';
  const DOCTOR_ID = 'pf-doctor';
  const PATIENT_ID = 'pf-patient';
  const FEE = 500;
  let paySeq = 0;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RAZORPAY_GATEWAY)
      .useValue(rp)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();

    prisma = app.get(PrismaService);
    payments = app.get(PaymentsService);

    await clean();
    await prisma.clinic.create({ data: { id: CLINIC_ID, name: 'PF Clinic' } });
    await prisma.doctor.create({
      data: { id: DOCTOR_ID, clinicId: CLINIC_ID, name: 'Dr PF', consultationFee: FEE },
    });
    // Same-day model: a session scheduled today so initiateBooking can resolve it.
    await prisma.doctorSession.create({
      data: {
        doctorId: DOCTOR_ID,
        sessionType: 'MORNING',
        startTime: '09:00',
        maxTokens: 50,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
    });
    await prisma.patient.create({ data: { id: PATIENT_ID, name: 'PF', mobile: '7000000123' } });
  });

  afterAll(async () => {
    await clean();
    await prisma.patient.deleteMany({ where: { id: PATIENT_ID } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  async function clean(): Promise<void> {
    await prisma.payment.deleteMany({ where: { booking: { doctorId: DOCTOR_ID } } });
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
  }

  /** Initiate a real booking (PENDING_PAYMENT + a CREATED payment + order). */
  async function initiate(): Promise<{ bookingId: string; orderId: string }> {
    const res = await payments.initiateBooking({
      patientId: PATIENT_ID,
      doctorId: DOCTOR_ID,
      source: BookingSource.APP,
    });
    return { bookingId: res.bookingId, orderId: res.orderId };
  }

  it('valid signature: expires the booking and marks the payment FAILED', async () => {
    const { bookingId, orderId } = await initiate();
    const wh = failedWebhook(orderId, `pay_fail_${paySeq++}`);

    await payments.handleWebhook(wh.raw, wh.sig);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe(BookingStatus.EXPIRED);
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(payment.status).toBe(PaymentStatus.FAILED);
  });

  it('invalid signature: rejected (no state change)', async () => {
    const { bookingId, orderId } = await initiate();
    const wh = failedWebhook(orderId, `pay_fail_${paySeq++}`);

    await expect(payments.handleWebhook(wh.raw, 'deadbeef')).rejects.toThrow(
      'invalid webhook signature',
    );

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe(BookingStatus.PENDING_PAYMENT); // untouched
  });

  it('idempotent: an already-CONFIRMED booking is not changed by payment.failed', async () => {
    const { bookingId, orderId } = await initiate();
    const paymentId = `pay_ok_${paySeq++}`;
    rp.setCaptured(orderId, paymentId, FEE * 100);
    await payments.confirm(orderId, paymentId); // -> BOOKED, or ACTIVE if front of queue

    // Snapshot the post-confirm state instead of asserting a literal status.
    // confirm() enqueues, and an enqueue that lands at rank 0 is promoted
    // straight to ACTIVE — so whether this booking is BOOKED or ACTIVE depends
    // on whether anyone else is already queued for this doctor/session. Pinning
    // it to BOOKED made the test pass only while stale queue entries from an
    // earlier run happened to sit in front of it, and fail on a clean Redis.
    // The invariant under test is that payment.failed changes NOTHING here.
    const confirmed = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect([BookingStatus.BOOKED, BookingStatus.ACTIVE]).toContain(confirmed.status);

    const wh = failedWebhook(orderId, paymentId);
    await payments.handleWebhook(wh.raw, wh.sig); // should be a no-op (returns 200)

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe(confirmed.status); // unchanged by the webhook
    expect(booking.tokenNumber).toBe(confirmed.tokenNumber);
    expect(booking.tokenNumber).toBeTruthy();
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(payment.status).toBe(PaymentStatus.SUCCESS);
  });

  it('idempotent: a second payment.failed for an already-failed booking is a no-op', async () => {
    const { bookingId, orderId } = await initiate();
    const wh = failedWebhook(orderId, `pay_fail_${paySeq++}`);

    await payments.handleWebhook(wh.raw, wh.sig);
    await payments.handleWebhook(wh.raw, wh.sig); // duplicate

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.status).toBe(BookingStatus.EXPIRED);
    const payment = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(payment.status).toBe(PaymentStatus.FAILED);
  });

  describe('cleanup sweep (expireStalePending)', () => {
    // isolate from the webhook tests above so the swept count is deterministic
    beforeAll(clean);

    it('expires a pending booking older than the cutoff, leaves a fresh one', async () => {
      const stale = await initiate();
      const fresh = await initiate();

      // age the stale booking past the 30-minute cutoff
      await prisma.booking.update({
        where: { id: stale.bookingId },
        data: { createdAt: new Date(Date.now() - 31 * 60_000) },
      });

      // sweep is global (all clinics) so assert on our specific bookings, not
      // the total count (other specs share the DB under parallel runs)
      const { expired } = await payments.expireStalePending(30);
      expect(expired).toBeGreaterThanOrEqual(1);

      const staleB = await prisma.booking.findUniqueOrThrow({ where: { id: stale.bookingId } });
      expect(staleB.status).toBe(BookingStatus.EXPIRED);
      const staleP = await prisma.payment.findFirstOrThrow({ where: { bookingId: stale.bookingId } });
      expect(staleP.status).toBe(PaymentStatus.FAILED);

      const freshB = await prisma.booking.findUniqueOrThrow({ where: { id: fresh.bookingId } });
      expect(freshB.status).toBe(BookingStatus.PENDING_PAYMENT); // untouched
    });

    it('leaves a recent pending booking untouched', async () => {
      const { bookingId } = await initiate(); // fresh — within the cutoff
      await payments.expireStalePending(30);
      const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
      expect(b.status).toBe(BookingStatus.PENDING_PAYMENT);
    });
  });
});
