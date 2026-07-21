// Voice secret MUST be set before the app (ConfigModule) boots.
process.env.VOICE_INTERNAL_SECRET = 'test-voice-secret';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SMS_SENDER, SmsSender } from '../src/auth/sms.sender';
import { QueueService } from '../src/queue-engine/queue.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import { VoiceQueueStatusRecord } from '../src/voice/voice.dto';

/** Captures SMS instead of sending, and can be made to fail on demand. */
class FakeSms implements SmsSender {
  texts: { mobile: string; message: string }[] = [];
  failNext = false;

  async sendOtp(): Promise<void> {
    /* unused here */
  }
  async sendText(mobile: string, message: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('provider down');
    }
    this.texts.push({ mobile, message });
  }
  reset(): void {
    this.texts.length = 0;
    this.failNext = false;
  }
}

/**
 * Voice queue-status + booking-confirmation SMS.
 *
 * Two clinics under one hospital, because the boundary worth proving is that a
 * caller's token at clinic B is invisible when they ring clinic A's number —
 * same patient record, different line.
 */
describe('Voice queue-status + booking SMS (real infra)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let queue: QueueService;
  let consult: ConsultationService;
  const sms = new FakeSms();

  const SECRET = 'test-voice-secret';
  const HOSP = 'vs-hosp';
  const CLINIC_A = 'vs-clinic-a';
  const CLINIC_B = 'vs-clinic-b';
  const DID_A = '+910000000011';
  const DID_B = '+910000000022';
  const DOC_A = 'vs-doc-a';
  const DOC_B = 'vs-doc-b';
  const CALLER = '9300009101';
  const FILLER = '9300009102';
  const STRANGER = '9300009103';

  let sessionA: SessionKey;
  let sessionB: SessionKey;

  const todayYmd = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_SENDER)
      .useValue(sms)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    queue = app.get(QueueService);
    consult = app.get(ConsultationService);

    sessionA = { doctorId: DOC_A, sessionDate: todayYmd(), sessionType: 'MORNING' };
    sessionB = { doctorId: DOC_B, sessionDate: todayYmd(), sessionType: 'MORNING' };

    await cleanup();

    await prisma.hospital.create({ data: { id: HOSP, name: 'VS Hospital' } });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A, hospitalId: HOSP, name: 'VS Clinic A' },
        { id: CLINIC_B, hospitalId: HOSP, name: 'VS Clinic B' },
      ],
    });
    await prisma.voiceNumber.createMany({
      data: [
        { didNumber: DID_A, clinicId: CLINIC_A },
        { didNumber: DID_B, clinicId: CLINIC_B },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        { id: DOC_A, clinicId: CLINIC_A, name: 'Dr Aruna', specialization: 'Cardiology', consultationFee: 400, avgConsultMinutes: 10 },
        { id: DOC_B, clinicId: CLINIC_B, name: 'Dr Bhaskar', specialization: 'Dermatology', consultationFee: 500, avgConsultMinutes: 10 },
      ],
    });
    await prisma.doctorSession.createMany({
      data: [DOC_A, DOC_B].map((doctorId) => ({
        doctorId,
        sessionType: SessionType.MORNING,
        startTime: '09:00',
        maxTokens: 20,
        daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      })),
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await queue.clearSession(sessionA);
    await queue.clearSession(sessionB);
    await prisma.voiceCallLog.deleteMany({ where: { didNumber: { in: [DID_A, DID_B] } } });
    const bookings = await prisma.booking.findMany({
      where: { doctorId: { in: [DOC_A, DOC_B] } },
      select: { id: true, paymentId: true },
    });
    await prisma.booking.deleteMany({ where: { doctorId: { in: [DOC_A, DOC_B] } } });
    await prisma.payment.deleteMany({
      where: { id: { in: bookings.map((b) => b.paymentId).filter((p): p is string => !!p) } },
    });
    await prisma.doctorSession.deleteMany({ where: { doctorId: { in: [DOC_A, DOC_B] } } });
    await prisma.doctor.deleteMany({ where: { id: { in: [DOC_A, DOC_B] } } });
    await prisma.voiceNumber.deleteMany({ where: { didNumber: { in: [DID_A, DID_B] } } });
    await prisma.patient.deleteMany({ where: { mobile: { in: [CALLER, FILLER, STRANGER] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.hospital.deleteMany({ where: { id: HOSP } });
  }

  const post = (path: string, body: unknown, secret: string | null = SECRET) =>
    fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret ? { 'x-voice-secret': secret } : {}),
      },
      body: JSON.stringify(body),
    });

  const status = (did: string, phone: string) =>
    post('/voice/queue-status', { didNumber: did, patientPhone: phone });

  // ── booking confirmation SMS ───────────────────────────────────────────────
  describe('booking confirmation SMS', () => {
    beforeAll(async () => {
      sms.reset();
      // A walk-in filler occupies rank 0, so the voice caller lands behind
      // someone — the realistic case and the one where a wait is quoted.
      const filler = await prisma.patient.create({
        data: { mobile: FILLER, name: 'Filler' },
        select: { id: true },
      });
      const fillerBooking = await prisma.booking.create({
        data: {
          patientId: filler.id,
          doctorId: DOC_A,
          source: 'WALK_IN',
          sessionDate: new Date(`${todayYmd()}T00:00:00.000Z`),
          sessionType: SessionType.MORNING,
          status: 'BOOKED',
        },
        select: { id: true },
      });
      await consult.enqueueBooking(TokenSource.WALK_IN, sessionA, fillerBooking.id);

      const res = await post('/voice/bookings', {
        didNumber: DID_A,
        doctorId: DOC_A,
        sessionType: 'MORNING',
        patientPhone: CALLER,
        patientName: 'Ravi',
        callSid: 'vs-call-1',
      });
      expect(res.status).toBe(201);
    });

    it('sends exactly one SMS, to the caller’s own number', () => {
      expect(sms.texts).toHaveLength(1);
      expect(sms.texts[0].mobile).toBe(CALLER);
    });

    it('the SMS is self-contained — token, doctor, clinic, wait, payment note', () => {
      const msg = sms.texts[0].message;
      expect(msg).toContain('A001'); // the voice token
      expect(msg).toContain('Dr Aruna');
      expect(msg).toContain('VS Clinic A');
      expect(msg).toMatch(/1 ahead of you/);
      expect(msg).toMatch(/pay at the reception desk/i);
      // A phone caller has no app — the SMS must not assume one.
      expect(msg).not.toMatch(/\bapp\b|http/i);
    });

    it('a failing SMS provider does not lose the booking', async () => {
      sms.failNext = true;
      const res = await post('/voice/bookings', {
        didNumber: DID_A,
        doctorId: DOC_A,
        sessionType: 'MORNING',
        patientPhone: STRANGER,
        callSid: 'vs-call-sms-fail',
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as { tokenNumber: string };
      expect(body.tokenNumber).toBeTruthy();

      // token really is in the live queue despite the SMS blowing up
      expect(await queue.list(sessionA)).toContain(body.tokenNumber);
    });
  });

  // ── queue status ──────────────────────────────────────────────────────────
  describe('POST /voice/queue-status', () => {
    it('returns the caller’s token with live position, wait, and who is being served', async () => {
      const res = await status(DID_A, CALLER);
      expect(res.status).toBe(201);
      const rows = (await res.json()) as VoiceQueueStatusRecord[];

      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.tokenNumber).toBe('A001');
      expect(r.doctorName).toBe('Dr Aruna');
      expect(r.specialization).toBe('Cardiology');
      expect(r.patientsAhead).toBe(1); // the walk-in filler
      expect(r.estimatedWaitMinutes).toBe(10); // 1 ahead x 10 min
      expect(r.currentlyServing).toBe('W001'); // the filler at rank 0
    });

    it('reflects the queue moving — position and wait drop after a DONE', async () => {
      await consult.markDone(sessionA, 'W001');

      const rows = (await status(DID_A, CALLER).then((r) => r.json())) as VoiceQueueStatusRecord[];
      expect(rows[0].patientsAhead).toBe(0);
      expect(rows[0].estimatedWaitMinutes).toBe(0);
      // now they are the one being served
      expect(rows[0].currentlyServing).toBe('A001');
    });

    it('returns an empty array — not a 404 — when the caller has no booking', async () => {
      const res = await status(DID_A, '9399999999');
      expect(res.status).toBe(201);
      expect(await res.json()).toEqual([]);
    });

    it('does not leak a booking held at another clinic', async () => {
      // Same caller takes a token at clinic B.
      const booked = await post('/voice/bookings', {
        didNumber: DID_B,
        doctorId: DOC_B,
        sessionType: 'MORNING',
        patientPhone: CALLER,
        callSid: 'vs-call-clinic-b',
      });
      expect(booked.status).toBe(201);

      // Ringing clinic A must show only clinic A's token.
      const fromA = (await status(DID_A, CALLER).then((r) => r.json())) as VoiceQueueStatusRecord[];
      expect(fromA.map((r) => r.doctorName)).toEqual(['Dr Aruna']);
      expect(JSON.stringify(fromA)).not.toContain('Dr Bhaskar');

      // and ringing clinic B shows only clinic B's.
      const fromB = (await status(DID_B, CALLER).then((r) => r.json())) as VoiceQueueStatusRecord[];
      expect(fromB.map((r) => r.doctorName)).toEqual(['Dr Bhaskar']);
    });

    it('404s an unknown DID', async () => {
      expect((await status('+919999999999', CALLER)).status).toBe(404);
    });

    it('requires didNumber and patientPhone', async () => {
      expect((await post('/voice/queue-status', { didNumber: DID_A })).status).toBe(400);
      expect((await post('/voice/queue-status', { patientPhone: CALLER })).status).toBe(400);
    });

    it('is gated by the voice secret', async () => {
      expect((await status(DID_A, CALLER).then((r) => r.status))).toBe(201);
      const res = await post('/voice/queue-status', { didNumber: DID_A, patientPhone: CALLER }, null);
      expect(res.status).toBe(401);
    });
  });
});
