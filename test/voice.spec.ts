// Voice secret MUST be set before the app (ConfigModule) boots.
process.env.VOICE_SECRET = 'test-voice-secret';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { BookingStatus, PaymentStatus, SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';

/**
 * Voice (phone) booking API end-to-end against real Postgres + Redis. Proves the
 * agent contract works: DID->clinic routing, pay-at-desk token issue, idempotent
 * booking, lookup, cancel + audit, call-log, the x-voice-secret gate, and the
 * reception desk settling the pay-at-desk payment.
 */
describe('Voice API (/voice) — real infra', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let queue: QueueService;

  const SECRET = 'test-voice-secret';
  const HOSP = 'vc-hosp';
  const CLINIC = 'vc-clinic';
  const DID = '+910000000001';
  const DOCTOR = 'vc-doctor';
  const PHONE = '9300009001';
  const FILLER_PHONE = '9300009002';

  let staffToken = '';
  let session: SessionKey;

  const todayYmd = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    queue = app.get(QueueService);

    // Deterministic session key so cleanup can wipe stale Redis (queue + token
    // counters) from a prior run BEFORE we seed — same-day always resolves here.
    session = { doctorId: DOCTOR, sessionDate: todayYmd(), sessionType: 'MORNING' };
    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'VC Hospital' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'VC Clinic' } });
    await prisma.voiceNumber.create({ data: { didNumber: DID, clinicId: CLINIC } });
    await prisma.doctor.create({
      data: { id: DOCTOR, clinicId: CLINIC, name: 'Dr Voice', specialization: 'Cardiology', consultationFee: 400, avgConsultMinutes: 10 },
    });
    // Same-day joinable session every day so resolveToday is OPEN on any run day.
    await prisma.doctorSession.create({
      data: { doctorId: DOCTOR, sessionType: SessionType.MORNING, startTime: '09:00', maxTokens: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] },
    });

    staffToken = app.get(AuthTokenService).sign({ sub: 'vc-staff', role: 'STAFF', clinicId: CLINIC, hospitalId: HOSP });

    // Pre-fill the queue with a walk-in so it isn't empty: that filler promotes to
    // ACTIVE at rank 0, leaving the later VOICE token at BOOKED (cancellable) — the
    // realistic case. (A lone first booking would auto-promote to ACTIVE.)
    const consult = app.get(ConsultationService);
    const today = todayYmd();
    const fp = await prisma.patient.create({ data: { mobile: FILLER_PHONE, name: 'Filler' }, select: { id: true } });
    const fb = await prisma.booking.create({
      data: { patientId: fp.id, doctorId: DOCTOR, source: 'WALK_IN', sessionDate: new Date(today), sessionType: SessionType.MORNING, status: BookingStatus.BOOKED },
      select: { id: true },
    });
    await consult.enqueueBooking(TokenSource.WALK_IN, { doctorId: DOCTOR, sessionDate: today, sessionType: 'MORNING' }, fb.id);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    if (session) await queue.clearSession(session).catch(() => undefined);
    await prisma.voiceCallLog.deleteMany({ where: { callSid: { in: ['call-1', 'log-1'] } } });
    await prisma.auditLog.deleteMany({ where: { doctorId: DOCTOR } });
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } });
    await prisma.payment.deleteMany({ where: { booking: { is: null } } }).catch(() => undefined);
    await prisma.patient.deleteMany({ where: { mobile: { in: [PHONE, FILLER_PHONE] } } });
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.voiceNumber.deleteMany({ where: { clinicId: CLINIC } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
    await prisma.hospital.deleteMany({ where: { id: HOSP } });
  }

  const voice = (path: string, body: unknown, secret: string | null = SECRET) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-voice-secret': secret } : {}),
      },
      body: JSON.stringify(body),
    });

  it('rejects without / with a wrong voice secret (401)', async () => {
    expect((await voice('/voice/availability', { didNumber: DID }, null)).status).toBe(401);
    expect((await voice('/voice/availability', { didNumber: DID }, 'wrong')).status).toBe(401);
  });

  it('availability resolves the DID to the clinic and lists same-day doctors', async () => {
    const res = await voice('/voice/availability', { didNumber: DID, specialty: 'cardio' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      clinicId: string; clinicName: string;
      doctors: Array<{ doctorId: string; consultationFee: number; sessions: Array<{ sessionType: string; waiting: number; etaMinutes: number }> }>;
    };
    expect(body.clinicId).toBe(CLINIC);
    const doc = body.doctors.find((d) => d.doctorId === DOCTOR);
    expect(doc).toBeDefined();
    expect(doc!.consultationFee).toBe(400);
    expect(doc!.sessions[0].sessionType).toBe('MORNING');
    expect(doc!.sessions[0].waiting).toBe(1); // the pre-filled walk-in
  });

  it('unknown DID -> 404', async () => {
    expect((await voice('/voice/availability', { didNumber: '+919999999999' }, SECRET)).status).toBe(404);
  });

  it('book issues a pay-at-desk VOICE token; idempotent on callSid', async () => {
    const res = await voice('/voice/bookings', {
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING',
      patientPhone: PHONE, patientName: 'Voice Caller', callSid: 'call-1',
    });
    expect(res.status).toBe(201);
    const b = (await res.json()) as { bookingId: string; tokenNumber: string; status: string; sessionDate: string };
    expect(b.tokenNumber).toBe('A001');
    expect(b.status).toBe('BOOKED');
    expect(b.sessionDate).toBe(session.sessionDate);

    const row = await prisma.booking.findUniqueOrThrow({
      where: { id: b.bookingId },
      select: { source: true, payAtDesk: true, voiceCallSid: true, payment: { select: { status: true, amount: true } } },
    });
    expect(row.source).toBe('VOICE');
    expect(row.payAtDesk).toBe(true);
    expect(row.voiceCallSid).toBe('call-1');
    expect(row.payment?.status).toBe(PaymentStatus.CREATED); // unpaid, due at desk
    expect(row.payment?.amount).toBe(40000); // ₹400 in paise

    // Retry with the SAME callSid -> same booking, no second token.
    const again = await voice('/voice/bookings', {
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING', patientPhone: PHONE, callSid: 'call-1',
    });
    const b2 = (await again.json()) as { bookingId: string; tokenNumber: string };
    expect(b2.bookingId).toBe(b.bookingId);
    expect(b2.tokenNumber).toBe('A001');
    expect(await queue.size(session)).toBe(2); // filler (W001) + voice (A001), no dup
  });

  it('rejects a session the caller asked for that is not the one open now (409)', async () => {
    const res = await voice('/voice/bookings', {
      didNumber: DID, doctorId: DOCTOR, sessionType: 'EVENING', // doctor only sits MORNING
      patientPhone: PHONE, callSid: 'call-mismatch',
    });
    expect(res.status).toBe(409);
  });

  it('a repeat call for a doctor already held returns the same token (no phantom hold)', async () => {
    const before = await queue.size(session);
    const res = await voice('/voice/bookings', {
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING',
      patientPhone: PHONE, callSid: 'call-different', // different call, same caller+doctor
    });
    expect(res.status).toBe(201);
    const b = (await res.json()) as { tokenNumber: string };
    expect(b.tokenNumber).toBe('A001'); // the existing hold, not a new token
    expect(await queue.size(session)).toBe(before); // queue unchanged
  });

  it('lookup returns the caller’s live appointment, scoped to the dialed clinic', async () => {
    const res = await voice('/voice/appointments/lookup', { didNumber: DID, patientPhone: PHONE });
    expect(res.status).toBe(201);
    const rows = (await res.json()) as Array<{ appointmentId: string; doctorId: string; tokenNumber: string; status: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].doctorId).toBe(DOCTOR);
    expect(rows[0].tokenNumber).toBe('A001');
  });

  it('reception collects the pay-at-desk payment -> Payment SUCCESS, roster shows paid', async () => {
    const lookup = (await (await voice('/voice/appointments/lookup', { didNumber: DID, patientPhone: PHONE })).json()) as Array<{ appointmentId: string }>;
    const bookingId = lookup[0].appointmentId;

    const res = await fetch(`${url}/reception/bookings/${bookingId}/collect-payment`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staffToken}` },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { paid: boolean; amountPaise: number };
    expect(body.paid).toBe(true);
    expect(body.amountPaise).toBe(40000);

    const pay = await prisma.payment.findFirstOrThrow({ where: { bookingId } });
    expect(pay.status).toBe(PaymentStatus.SUCCESS);
  });

  it('cancel cancels the booking and records a VOICE-channel audit entry', async () => {
    const lookup = (await (await voice('/voice/appointments/lookup', { didNumber: DID, patientPhone: PHONE })).json()) as Array<{ appointmentId: string }>;
    const bookingId = lookup[0].appointmentId;

    const res = await voice('/voice/appointments/cancel', { appointmentId: bookingId });
    expect(res.status).toBe(201);
    const rec = (await res.json()) as { status: string };
    expect(rec.status).toBe('CANCELLED');

    const row = await prisma.booking.findUniqueOrThrow({ where: { id: bookingId } });
    expect(row.status).toBe(BookingStatus.CANCELLED);

    const audit = await prisma.auditLog.findFirst({ where: { bookingId, action: 'CANCEL' } });
    expect(audit).not.toBeNull();
    expect((audit!.metadata as { channel?: string }).channel).toBe('VOICE');

    // gone from the live queue (the filler walk-in remains)
    expect(await queue.size(session)).toBe(1);
  });

  it('call-logs persists idempotently by callSid', async () => {
    const r1 = await voice('/voice/call-logs', { callSid: 'log-1', didNumber: DID, callerPhone: PHONE, outcome: 'booked', duration: 42 });
    expect(r1.status).toBe(201);
    const r2 = await voice('/voice/call-logs', { callSid: 'log-1', didNumber: DID, callerPhone: PHONE, outcome: 'cancelled', duration: 50 });
    expect(r2.status).toBe(201);

    const logs = await prisma.voiceCallLog.findMany({ where: { callSid: 'log-1' } });
    expect(logs.length).toBe(1); // upserted, not duplicated
    expect(logs[0].outcome).toBe('cancelled'); // last write wins
    expect(logs[0].clinicId).toBe(CLINIC); // DID resolved
  });
});
