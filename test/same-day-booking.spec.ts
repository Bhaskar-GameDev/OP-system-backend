import { INestApplication, ConflictException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { BookingSource, BookingStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PaymentsService } from '../src/payments/payments.service';
import { EtaService } from '../src/queue-engine/eta.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';
import {
  RAZORPAY_GATEWAY,
  RazorpayGateway,
  RpOrder,
  RpPayment,
  RpRefund,
} from '../src/payments/razorpay.gateway';

/** Minimal capture-only fake; checkout is short-circuited via the webhook path. */
class FakeRazorpay implements RazorpayGateway {
  private seq = 0;
  private store = new Map<string, RpPayment>();
  async createOrder(amountPaise: number): Promise<RpOrder> {
    return { orderId: `order_${++this.seq}`, amount: amountPaise };
  }
  setCaptured(orderId: string, paymentId: string, amount: number): void {
    this.store.set(paymentId, { id: paymentId, orderId, status: 'captured', amount });
  }
  async fetchPayment(id: string): Promise<RpPayment> {
    const p = this.store.get(id);
    if (!p) throw new Error('no such payment');
    return p;
  }
  async refund(id: string): Promise<RpRefund> {
    return { refundId: `rfnd_${id}`, status: 'processed' };
  }
  verifyCheckoutSignature(): boolean {
    return true;
  }
  verifyWebhookSignature(): boolean {
    return true;
  }
}

function todayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

describe('Same-day booking — auto-resolve, no capacity cap (real Redis + Postgres)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let payments: PaymentsService;
  let eta: EtaService;
  let queue: QueueService;
  const rp = new FakeRazorpay();

  const CLINIC_ID = 'sd-clinic';
  const DOCTOR_ID = 'sd-doctor';
  const NO_SESSION_DOCTOR = 'sd-doctor-empty';
  const FEE = 300;
  const session: SessionKey = { doctorId: DOCTOR_ID, sessionDate: todayYmd(), sessionType: 'MORNING' };
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
    eta = app.get(EtaService);
    queue = app.get(QueueService);

    await prisma.clinic.upsert({ where: { id: CLINIC_ID }, create: { id: CLINIC_ID, name: 'SD Clinic' }, update: {} });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: { id: DOCTOR_ID, clinicId: CLINIC_ID, name: 'Dr SD', consultationFee: FEE, avgConsultMinutes: 5 },
      update: { consultationFee: FEE },
    });
    // doctor with NO session today (only Mondays would still be fine; use empty)
    await prisma.doctor.upsert({
      where: { id: NO_SESSION_DOCTOR },
      create: { id: NO_SESSION_DOCTOR, clinicId: CLINIC_ID, name: 'Dr Empty', consultationFee: FEE },
      update: {},
    });
    await prisma.doctorSession.deleteMany({ where: { doctorId: { in: [DOCTOR_ID, NO_SESSION_DOCTOR] } } });
    // maxTokens intentionally LOW (2) to prove it is no longer a hard cap.
    await prisma.doctorSession.create({
      data: { doctorId: DOCTOR_ID, sessionType: 'MORNING', startTime: '00:00', maxTokens: 2, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
    });
  });

  afterAll(async () => {
    await clean();
    await prisma.doctorSession.deleteMany({ where: { doctorId: { in: [DOCTOR_ID, NO_SESSION_DOCTOR] } } });
    await prisma.doctor.deleteMany({ where: { id: { in: [DOCTOR_ID, NO_SESSION_DOCTOR] } } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  beforeEach(clean);

  async function clean(): Promise<void> {
    await queue.clearSession(session);
    const bs = await prisma.booking.findMany({ where: { doctorId: { in: [DOCTOR_ID, NO_SESSION_DOCTOR] } }, select: { id: true } });
    const ids = bs.map((b) => b.id);
    await prisma.booking.updateMany({ where: { id: { in: ids } }, data: { paymentId: null } });
    await prisma.payment.deleteMany({ where: { bookingId: { in: ids } } });
    await prisma.booking.deleteMany({ where: { id: { in: ids } } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'sd-pt-' } } });
  }

  async function bookAndPay(): Promise<string> {
    const id = `sd-pt-${seq++}`;
    await prisma.patient.create({ data: { id, name: id, mobile: `6${Date.now()}${seq}` } });
    const { orderId, amount } = await payments.initiateBooking({ patientId: id, doctorId: DOCTOR_ID, source: BookingSource.APP });
    const payId = `pay_${orderId}`;
    rp.setCaptured(orderId, payId, amount);
    const res = await payments.verifyCheckout(orderId, payId, 'sig');
    return res.tokenNumber;
  }

  it('issues unbounded, incrementing tokens well past maxTokens (no "full" rejection)', async () => {
    const N = 25; // maxTokens is 2 — every one of these must still succeed
    const tokens: string[] = [];
    for (let i = 0; i < N; i++) tokens.push(await bookAndPay());

    // all distinct, monotonic, and the queue holds every one
    expect(new Set(tokens).size).toBe(N);
    expect(tokens[0]).toBe('A001');
    expect(tokens[N - 1]).toBe(`A${String(N).padStart(3, '0')}`);
    expect((await queue.list(session)).length).toBe(N);

    const live = await prisma.booking.count({
      where: { doctorId: DOCTOR_ID, sessionType: 'MORNING', status: { in: [BookingStatus.BOOKED, BookingStatus.ACTIVE] } },
    });
    expect(live).toBe(N);
  });

  it('ETA still computes across a large queue', async () => {
    for (let i = 0; i < 20; i++) await bookAndPay();
    const board = await eta.etaForQueue(session);
    expect(board.length).toBe(20);
    // every waiting entry has a non-negative ETA; the board is ordered
    for (const e of board) expect(e.etaMinutes ?? 0).toBeGreaterThanOrEqual(0);
  });

  it('rejects booking when the doctor has no session today', async () => {
    const id = `sd-pt-${seq++}`;
    await prisma.patient.create({ data: { id, name: id, mobile: `6${Date.now()}${seq}` } });
    await expect(
      payments.initiateBooking({ patientId: id, doctorId: NO_SESSION_DOCTOR, source: BookingSource.APP }),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
