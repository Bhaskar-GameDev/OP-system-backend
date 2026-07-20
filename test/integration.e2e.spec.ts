import { createHmac } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { io, Socket } from 'socket.io-client';
import { BookingSource, BookingStatus, PaymentStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { PasswordService } from '../src/auth/password.service';
import { SMS_SENDER, SmsSender } from '../src/auth/sms.sender';
import { PUSH_SENDER, PushMessage, PushSender } from '../src/notifications/push.sender';
import {
  RAZORPAY_GATEWAY,
  RazorpayGateway,
  RpOrder,
  RpPayment,
  RpRefund,
  hmacEquals,
} from '../src/payments/razorpay.gateway';
import { DiscoveryService } from '../src/discovery/discovery.service';
import { PaymentsService } from '../src/payments/payments.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { NotificationsService, NotificationType } from '../src/notifications/notifications.service';
import { ArchivalService } from '../src/archival/archival.service';
import { BookingsService } from '../src/bookings/bookings.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';

// tight thresholds so a DONE genuinely crosses the new front INTO the arrival
// window (with the defaults a tiny queue is entirely within range on entry).
process.env.NOTIFY_APPROACHING_AHEAD = '2';
process.env.NOTIFY_ARRIVAL_AHEAD = '0';

const KEY_SECRET = 'test_key_secret';
const WEBHOOK_SECRET = 'test_webhook_secret';

class FakeRazorpay implements RazorpayGateway {
  private seq = 0;
  readonly payments = new Map<string, RpPayment>();
  readonly refunds: string[] = [];
  async createOrder(amountPaise: number): Promise<RpOrder> {
    return { orderId: `order_${++this.seq}`, amount: amountPaise };
  }
  capture(orderId: string, paymentId: string, amount: number): void {
    this.payments.set(paymentId, { id: paymentId, orderId, status: 'captured', amount });
  }
  async fetchPayment(id: string): Promise<RpPayment> {
    const p = this.payments.get(id);
    if (!p) throw new Error('no payment');
    return p;
  }
  async refund(id: string): Promise<RpRefund> {
    this.refunds.push(id);
    return { refundId: `rfnd_${id}`, status: 'processed' };
  }
  verifyCheckoutSignature(o: string, p: string, s: string): boolean {
    return hmacEquals(KEY_SECRET, `${o}|${p}`, s);
  }
  verifyWebhookSignature(raw: string, s: string): boolean {
    return hmacEquals(WEBHOOK_SECRET, raw, s);
  }
}
const checkoutSig = (o: string, p: string): string =>
  createHmac('sha256', KEY_SECRET).update(`${o}|${p}`).digest('hex');
/** Today as local YYYY-MM-DD (same-day booking resolves onto today). */
function e2eTodayYmd(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

class CapturingSms implements SmsSender {
  last?: { mobile: string; otp: string };
  async sendOtp(mobile: string, otp: string): Promise<void> {
    this.last = { mobile, otp };
  }
}

class FakePush implements PushSender {
  readonly sent: { deviceToken: string; message: PushMessage }[] = [];
  async send(deviceToken: string, message: PushMessage): Promise<void> {
    this.sent.push({ deviceToken, message });
  }
}

/**
 * End-to-end: discovery -> pay -> token -> walk-in -> socket snapshot -> DONE +
 * notification -> no-show/skip/priority ordering -> archival -> history split.
 * Real Redis + Postgres + websocket. Tests that the modules AGREE when chained.
 */
describe('Integration — full real chain (Redis + Postgres + WS)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let auth: AuthService;
  let discovery: DiscoveryService;
  let payments: PaymentsService;
  let consult: ConsultationService;
  let queue: QueueService;
  let notifications: NotificationsService;
  let archival: ArchivalService;
  let bookings: BookingsService;

  const rp = new FakeRazorpay();
  const sms = new CapturingSms();
  const push = new FakePush();

  const CLINIC_ID = 'e2e-clinic';
  const DOCTOR_ID = 'e2e-doctor';
  // Same-day model: APP bookings resolve onto today's session, so the queue key
  // and the directly-seeded bookings must all sit on today.
  const session: SessionKey = { doctorId: DOCTOR_ID, sessionDate: e2eTodayYmd(), sessionType: 'MORNING' };

  const MOBILE_A = '9100000001';
  let patientA = '';
  let patientAToken = '';
  let doctorToken = '';
  const extraPatients: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RAZORPAY_GATEWAY).useValue(rp)
      .overrideProvider(SMS_SENDER).useValue(sms)
      .overrideProvider(PUSH_SENDER).useValue(push)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    discovery = app.get(DiscoveryService);
    payments = app.get(PaymentsService);
    consult = app.get(ConsultationService);
    queue = app.get(QueueService);
    notifications = app.get(NotificationsService);
    archival = app.get(ArchivalService);
    bookings = app.get(BookingsService);
    const passwords = app.get(PasswordService);

    await cleanup();

    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'E2E Clinic', address: '1 Health Rd' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: {
        id: DOCTOR_ID, clinicId: CLINIC_ID, name: 'Evelyn Cross',
        specialization: 'Cardiology', consultationFee: 600, avgConsultMinutes: 5,
        username: 'dr.e2e', passwordHash: await passwords.hash('docpass'),
      },
      update: { username: 'dr.e2e', passwordHash: await passwords.hash('docpass'), consultationFee: 600 },
    });
    // Same-day session every weekday so initiateBooking resolves today's MORNING.
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.doctorSession.create({
      data: {
        doctorId: DOCTOR_ID, sessionType: 'MORNING', startTime: '09:00',
        maxTokens: 100, daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      },
    });

    // patient A via REAL OTP login + registered device
    await auth.requestPatientOtp(MOBILE_A);
    const a = await auth.verifyPatientOtp(MOBILE_A, sms.last!.otp);
    patientAToken = a.token;
    patientA = a.sub;
    await prisma.patient.update({ where: { id: patientA }, data: { fcmToken: 'fcm-A' } });

    doctorToken = (await auth.doctorLogin('dr.e2e', 'docpass')).token;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await queue.clearSession(session);
    await notifications.clearSessionFlags(session);
    await prisma.bookingHistory.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.payment.deleteMany({ where: { booking: { is: null } } }).catch(() => undefined);
    await prisma.patient.deleteMany({ where: { mobile: { in: [MOBILE_A] } } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'e2e-pt-' } } });
  }

  /** create a bare patient (no login needed) with a device token. */
  async function makePatient(tag: string): Promise<string> {
    const id = `e2e-pt-${tag}`;
    await prisma.patient.create({
      data: { id, name: tag, mobile: `92${Date.now()}${extraPatients.length}`, fcmToken: `fcm-${tag}` },
    });
    extraPatients.push(id);
    return id;
  }

  /** initiate + pay an APP booking for a patient -> returns issued token. */
  async function payApp(patientId: string): Promise<string> {
    const { bookingId, orderId, amount } = await payments.initiateBooking({
      patientId, doctorId: DOCTOR_ID, source: BookingSource.APP,
    });
    const paymentId = `pay_${orderId}`;
    rp.capture(orderId, paymentId, amount);
    const res = await payments.verifyCheckout(orderId, paymentId, checkoutSig(orderId, paymentId));
    return res.tokenNumber;
  }

  function connect(token: string): Socket {
    return io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  }
  function next(socket: Socket, events: string[], timeoutMs = 3000): Promise<{ event: string; data: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout: ${events.join('|')}`)), timeoutMs);
      for (const ev of events) socket.once(ev, (data: unknown) => { clearTimeout(timer); resolve({ event: ev, data }); });
    });
  }
  async function waitFor(pred: () => boolean, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error('waitFor timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  it('runs the full booking → consult → reorder → archive → history chain consistently', async () => {
    // ── 1. discover the doctor (public) ──────────────────────────────
    const found = await discovery.searchDoctors('cardiology');
    expect(found.items.some((d) => d.id === DOCTOR_ID)).toBe(true);
    const profile = await discovery.getDoctor(DOCTOR_ID);
    expect(profile.consultationFee).toBe(600);
    expect(JSON.stringify(profile)).not.toContain('passwordHash');

    // ── 2. patient A: create booking + pay (sandbox) → token A001 ─────
    const tokenA = await payApp(patientA);
    expect(tokenA).toBe('A001');
    const bookingA = await prisma.booking.findFirstOrThrow({ where: { patientId: patientA, tokenNumber: 'A001' } });
    expect(bookingA.status).toBe(BookingStatus.ACTIVE); // front of empty queue
    const payA = await prisma.payment.findFirstOrThrow({ where: { bookingId: bookingA.id } });
    expect(payA.status).toBe(PaymentStatus.SUCCESS);
    // booking-confirmed push fired exactly for patient A
    expect(push.sent.some((s) => s.message.data.type === NotificationType.BOOKING_CONFIRMED && s.message.data.bookingId === bookingA.id)).toBe(true);

    // ── 3. second patient: walk-in token W001 ────────────────────────
    const patientB = await makePatient('B');
    const bookingB = await prisma.booking.create({
      data: { patientId: patientB, doctorId: DOCTOR_ID, source: BookingSource.WALK_IN, sessionDate: new Date(session.sessionDate), sessionType: 'MORNING', status: BookingStatus.BOOKED },
    });
    const wEntry = await consult.enqueueBooking(TokenSource.WALK_IN, session, bookingB.id);
    await prisma.booking.update({ where: { id: bookingB.id }, data: { tokenNumber: wEntry.tokenNumber } });
    expect(wEntry.tokenNumber).toBe('W001');
    expect(await queue.list(session)).toEqual(['A001', 'W001']);

    // ── 4. patient app socket: correct PRIVATE snapshot (own eta only) ─
    const sock = connect(patientAToken);
    sock.emit('join', { ...session, token: 'A001' });
    const snap = await next(sock, ['snapshot', 'error']);
    expect(snap.event).toBe('snapshot');
    const sd = snap.data as { kind: string; eta: { tokenNumber: string; patientsAhead: number; etaMinutes: number } };
    expect(sd.kind).toBe('booking');
    expect(sd.eta.tokenNumber).toBe('A001');
    expect(sd.eta.patientsAhead).toBe(0);
    expect(sd.eta.etaMinutes).toBe(0);
    sock.close();

    // history split right now: A has A001 ACTIVE (upcoming), nothing past
    {
      const up = await bookings.upcoming(patientA);
      const past = await bookings.past(patientA);
      expect(up.items.map((b) => b.tokenNumber)).toContain('A001');
      expect(past.total).toBe(0);
    }

    // ── 5. doctor presses DONE → W001 promoted, notification fires ────
    const beforeDone = push.sent.length;
    const done = await consult.markDone(session, 'A001');
    expect(done.doneToken).toBe('A001');
    expect(done.newActiveToken).toBe('W001');
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingA.id } })).status).toBe(BookingStatus.COMPLETED);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: bookingB.id } })).status).toBe(BookingStatus.ACTIVE);
    // the subscription (second consumer) pushed for the newly-fronted W001
    await waitFor(() => push.sent.slice(beforeDone).some((s) => s.message.data.token === 'W001'));

    // ── 6. no-show + skip + emergency-priority in the SAME session ────
    const patientC = await makePatient('C');
    const patientD = await makePatient('D');
    const patientE = await makePatient('E');
    // two more paid APP bookings behind W001
    expect(await payApp(patientC)).toBe('A002');
    expect(await payApp(patientD)).toBe('A003');
    expect(await queue.list(session)).toEqual(['W001', 'A002', 'A003']);

    // no-show the mid-queue A002
    await consult.markNoShow(session, 'A002');
    expect(await queue.list(session)).toEqual(['W001', 'A003']);

    // skip the active W001 -> back; A003 promoted
    await consult.skip(session, 'W001');
    expect(await queue.list(session)).toEqual(['A003', 'W001']);

    // emergency priority: patient E inserted just behind active A003, ahead of W001
    const bookingE = await prisma.booking.create({
      data: { patientId: patientE, doctorId: DOCTOR_ID, source: BookingSource.APP, sessionDate: new Date(session.sessionDate), sessionType: 'MORNING', status: BookingStatus.BOOKED },
    });
    const prio = await consult.priorityInsert(TokenSource.APP, session, bookingE.id);
    await prisma.booking.update({ where: { id: bookingE.id }, data: { tokenNumber: prio.token } });
    expect(prio.token).toBe('A004');

    // FINAL ORDER must be exactly this
    expect(await queue.list(session)).toEqual(['A003', 'A004', 'W001']);

    // ── 7. archival sweep: yesterday moves, today stays ──────────────
    // give patient A a settled booking dated yesterday
    const yesterday = new Date(Date.now() - 24 * 3600 * 1000);
    const oldBooking = await prisma.booking.create({
      data: { patientId: patientA, doctorId: DOCTOR_ID, source: BookingSource.APP, tokenNumber: 'A900', sessionDate: yesterday, sessionType: 'MORNING', status: BookingStatus.COMPLETED, createdAt: yesterday, consultationEndedAt: yesterday },
    });
    const { archived } = await archival.runSweep();
    expect(archived).toBeGreaterThanOrEqual(1);
    // yesterday's booking moved out of live, into history
    expect(await prisma.booking.findUnique({ where: { id: oldBooking.id } })).toBeNull();
    expect(await prisma.bookingHistory.findUnique({ where: { bookingId: oldBooking.id } })).not.toBeNull();
    // A001 was COMPLETED *today* -> still live (same-day stays)
    expect(await prisma.booking.findUnique({ where: { id: bookingA.id } })).not.toBeNull();

    // ── 8. history endpoint: correct past/upcoming split for patient A ─
    const past = await bookings.past(patientA);
    const tokens = past.items.map((b) => b.tokenNumber);
    expect(tokens).toContain('A001'); // today's completed (live terminal)
    expect(tokens).toContain('A900'); // yesterday's (archived)
    expect(past.items.find((b) => b.tokenNumber === 'A900')?.archived).toBe(true);
    expect(past.items.find((b) => b.tokenNumber === 'A001')?.archived).toBe(false);
    // sorted most-recent first
    expect(past.items[0].sessionDate >= past.items[past.items.length - 1].sessionDate).toBe(true);

    // and over HTTP with patient A's real token — no auth fields leaked
    const httpRes = await fetch(`${url}/me/bookings/past`, { headers: { authorization: `Bearer ${patientAToken}` } });
    expect(httpRes.status).toBe(200);
    const httpBody = await httpRes.text();
    expect(httpBody).not.toContain('passwordHash');
    expect(httpBody).not.toContain('fcmToken');
    expect(httpBody).not.toContain('fcm-A');
  });
});
