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
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';

/** Sandbox-faithful fake: same HMAC algo + status semantics as real Razorpay. */
class FakeRazorpay implements RazorpayGateway {
  private orderSeq = 0;
  readonly payments = new Map<string, RpPayment>();
  readonly refunds: string[] = [];

  async createOrder(amountPaise: number): Promise<RpOrder> {
    const orderId = `order_${++this.orderSeq}`;
    return { orderId, amount: amountPaise };
  }
  /** test helper: mark a payment captured against an order. */
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
    return { refundId: `rfnd_${paymentId}`, status: 'processed' };
  }
  verifyCheckoutSignature(orderId: string, paymentId: string, signature: string): boolean {
    return hmacEquals(KEY_SECRET, `${orderId}|${paymentId}`, signature);
  }
  verifyWebhookSignature(rawBody: string, signature: string): boolean {
    return hmacEquals(WEBHOOK_SECRET, rawBody, signature);
  }
}

function checkoutSig(orderId: string, paymentId: string): string {
  return createHmac('sha256', KEY_SECRET).update(`${orderId}|${paymentId}`).digest('hex');
}
/** Today as local YYYY-MM-DD (same-day booking resolves onto today). */
function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function webhookBody(orderId: string, paymentId: string): { raw: string; sig: string } {
  const raw = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: orderId } } },
  });
  const sig = createHmac('sha256', WEBHOOK_SECRET).update(raw).digest('hex');
  return { raw, sig };
}

describe('PaymentsService — idempotent confirm + cancel (real Redis + Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let queue: QueueService;
  const rp = new FakeRazorpay();

  const CLINIC_ID = 'pay-clinic';
  const DOCTOR_ID = 'pay-doctor';
  const FEE = 500; // rupees -> 50000 paise
  // Same-day model: bookings resolve onto TODAY's session, so the queue key the
  // assertions clear/inspect must be today + the seeded session type.
  const session: SessionKey = {
    doctorId: DOCTOR_ID,
    sessionDate: todayYmd(),
    sessionType: 'MORNING',
  };
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
    queue = app.get(QueueService);

    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'Pay Clinic' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: { id: DOCTOR_ID, clinicId: CLINIC_ID, name: 'Dr Pay', consultationFee: FEE },
      update: { consultationFee: FEE },
    });
    // A single MORNING session every weekday so resolveToday always resolves it.
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.doctorSession.create({
      data: {
        doctorId: DOCTOR_ID,
        sessionType: 'MORNING',
        startTime: '09:00',
        maxTokens: 50,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
    });
  });

  beforeEach(async () => {
    await clean();
  });

  afterAll(async () => {
    await clean();
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  async function clean(): Promise<void> {
    await queue.clearSession(session);
    const bs = await prisma.booking.findMany({
      where: { doctorId: DOCTOR_ID },
      select: { id: true },
    });
    const ids = bs.map((b) => b.id);
    await prisma.booking.updateMany({ where: { doctorId: DOCTOR_ID }, data: { paymentId: null } });
    await prisma.payment.deleteMany({ where: { bookingId: { in: ids } } });
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'pay-pt-' } } });
  }

  async function patient(): Promise<string> {
    const id = `pay-pt-${paySeq++}`;
    await prisma.patient.create({
      data: { id, name: id, mobile: `5${Date.now()}${paySeq}` },
    });
    return id;
  }

  /** initiate a booking + order, return {bookingId, orderId, paymentId}. */
  async function startAndPay(): Promise<{ bookingId: string; orderId: string; paymentId: string }> {
    const pid = await patient();
    const { bookingId, orderId, amount } = await payments.initiateBooking({
      patientId: pid,
      doctorId: DOCTOR_ID,
      source: BookingSource.APP,
    });
    const paymentId = `pay_${orderId}`;
    rp.setCaptured(orderId, paymentId, amount);
    return { bookingId, orderId, paymentId };
  }

  it('successful payment issues exactly ONE token', async () => {
    const { bookingId, orderId, paymentId } = await startAndPay();

    const res = await payments.verifyCheckout(orderId, paymentId, checkoutSig(orderId, paymentId));
    expect(res.alreadyProcessed).toBe(false);
    expect(res.tokenNumber).toBe('A001');

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.tokenNumber).toBe('A001');
    expect(booking.status).not.toBe(BookingStatus.PENDING_PAYMENT); // BOOKED -> ACTIVE (front)

    const pay = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(pay.status).toBe(PaymentStatus.SUCCESS);
    expect(pay.razorpayPaymentId).toBe(paymentId);

    // exactly one token in the queue
    expect(await queue.size(session)).toBe(1);
    expect(await queue.list(session)).toEqual(['A001']);
  });

  it('rejects unconfirmed/forged signatures and never issues a token', async () => {
    const { orderId, paymentId } = await startAndPay();
    await expect(
      payments.verifyCheckout(orderId, paymentId, 'forged-signature'),
    ).rejects.toThrow(/invalid payment signature/);
    expect(await queue.size(session)).toBe(0);
  });

  it('a retried/duplicate webhook does NOT issue a second token', async () => {
    const { bookingId, orderId, paymentId } = await startAndPay();

    // first: sync verify issues the token
    const first = await payments.verifyCheckout(orderId, paymentId, checkoutSig(orderId, paymentId));
    expect(first.alreadyProcessed).toBe(false);

    // duplicate via webhook path (same payment) -> no-op
    const wh = webhookBody(orderId, paymentId);
    await payments.handleWebhook(wh.raw, wh.sig);
    // a SECOND duplicate webhook too
    await payments.handleWebhook(wh.raw, wh.sig);

    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(booking.tokenNumber).toBe('A001');
    expect(await queue.size(session)).toBe(1); // still exactly one
  });

  it('concurrent webhook + sync verify for the same payment issues ONE token', async () => {
    const { orderId, paymentId } = await startAndPay();
    const wh = webhookBody(orderId, paymentId);

    const settled = await Promise.allSettled([
      payments.verifyCheckout(orderId, paymentId, checkoutSig(orderId, paymentId)),
      payments.handleWebhook(wh.raw, wh.sig),
    ]);
    expect(settled.every((s) => s.status === 'fulfilled')).toBe(true);

    expect(await queue.size(session)).toBe(1);
    expect(await queue.list(session)).toEqual(['A001']);
  });

  it('cancelling a BOOKED booking retains the payment as REFUNDED AND removes it from the Redis queue', async () => {
    // first patient pays -> A001 ACTIVE (front)
    const a = await startAndPay();
    await payments.verifyCheckout(a.orderId, a.paymentId, checkoutSig(a.orderId, a.paymentId));

    // second patient pays -> W... no, APP again -> A002, BOOKED (waiting behind A001)
    const b = await startAndPay();
    await payments.verifyCheckout(b.orderId, b.paymentId, checkoutSig(b.orderId, b.paymentId));

    const bBooking = await prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } });
    expect(bBooking.status).toBe(BookingStatus.BOOKED);
    expect(await queue.list(session)).toEqual(['A001', 'A002']);

    const res = await payments.cancelBooking(b.bookingId);
    expect(res.refunded).toBe(true);
    expect(rp.refunds).toContain(b.paymentId);

    // gone from the queue (no ghost token)
    expect(await queue.list(session)).toEqual(['A001']);
    // payment RETAINED as REFUNDED with the Razorpay refund reference (audit trail)
    const pay = await prisma.payment.findFirstOrThrow({ where: { bookingId: b.bookingId } });
    expect(pay.status).toBe(PaymentStatus.REFUNDED);
    expect(pay.razorpayRefundId).toBe(`rfnd_${b.paymentId}`);
    // booking marked cancelled, still linked to the retained payment
    const after = await prisma.booking.findUniqueOrThrow({ where: { id: b.bookingId } });
    expect(after.status).toBe(BookingStatus.CANCELLED);
    expect(after.paymentId).toBe(pay.id);
  });

  it('cannot cancel an ACTIVE booking', async () => {
    const a = await startAndPay();
    await payments.verifyCheckout(a.orderId, a.paymentId, checkoutSig(a.orderId, a.paymentId));
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: a.bookingId } });
    expect(booking.status).toBe(BookingStatus.ACTIVE); // front of empty queue
    await expect(payments.cancelBooking(a.bookingId)).rejects.toThrow(/cannot cancel/);
  });
});
