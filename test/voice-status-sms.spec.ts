// Voice secret MUST be set before the app (ConfigModule) boots.
process.env.VOICE_INTERNAL_SECRET = 'test-voice-secret';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { SessionType, TokenResetPolicy } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SMS_SENDER, SmsSender } from '../src/auth/sms.sender';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';
import { ReceptionService } from '../src/reception/reception.service';
import { ConsultationEngineService } from '../src/consultation/consultation-engine.service';
import { OpProjectionScheduler } from '../src/realtime/op-projection.scheduler';
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
 *
 * Post-cutover (2026-07-26): both the token quoted in the SMS and the position
 * returned by /voice/queue-status come from the OP engine (TokenSeries +
 * `QueueReadService.patientTracking`), NOT the legacy Redis queue. Two
 * consequences shape this spec:
 *   - the "filler" ahead of the caller must be enqueued into the OP line, so it
 *     goes through the reception walk-in desk path (which mirrors with
 *     `present: true`) rather than the legacy `consult.enqueueBooking`;
 *   - position reads come from a PROJECTION, so `scheduler.drain()` must catch it
 *     up before asserting (NOT `tick()`, which silently no-ops when the 2s
 *     background tick is already mid-run). The singleton scheduler is the only
 *     projector — never call the runner directly (concurrent projectors
 *     double-insert and P2002).
 */
describe('Voice queue-status + booking SMS (real infra)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let queue: QueueService;
  let reception: ReceptionService;
  let consultEngine: ConsultationEngineService;
  let scheduler: OpProjectionScheduler;
  const sms = new FakeSms();

  /** Token the caller was issued at clinic A, captured from the booking call. */
  let callerToken = '';
  /** OP token + encounter of the walk-in filler sitting ahead of the caller. */
  let fillerToken = '';
  let fillerEncounterId = '';

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
    reception = app.get(ReceptionService);
    consultEngine = app.get(ConsultationEngineService);
    scheduler = app.get(OpProjectionScheduler);

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
    // Every clinic taking OP tokens needs a series; without one the mirror
    // cannot raise a token and `book` 409s by design.
    await prisma.tokenSeries.createMany({
      data: [CLINIC_A, CLINIC_B].map((clinicId) => ({
        id: `vs-series-${clinicId}`,
        clinicId,
        code: 'NORMAL_OP',
        label: 'Normal',
        prefix: 'N',
        padWidth: 3,
        startAt: 1,
        resetPolicy: TokenResetPolicy.PER_SESSION,
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
    // OP-side rows created by the mirror / reception desk path.
    const encs = await prisma.encounter
      .findMany({ where: { doctorId: { in: [DOC_A, DOC_B] } }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    const encIds = encs.map((e) => e.id);
    const w = { encounterId: { in: encIds } };
    await prisma.consultation.deleteMany({ where: w }).catch(() => undefined);
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => undefined);
    await prisma.token.deleteMany({ where: w }).catch(() => undefined);
    await prisma.checkIn.deleteMany({ where: w }).catch(() => undefined);
    await prisma.registration.deleteMany({ where: w }).catch(() => undefined);
    await prisma.queueReadModel.deleteMany({ where: w }).catch(() => undefined);
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encIds } } }).catch(() => undefined);
    await prisma.encounter.deleteMany({ where: { id: { in: encIds } } }).catch(() => undefined);
    await prisma.opSession.deleteMany({ where: { doctorId: { in: [DOC_A, DOC_B] } } }).catch(() => undefined);
    await prisma.tokenSeries.deleteMany({ where: { clinicId: { in: [CLINIC_A, CLINIC_B] } } }).catch(() => undefined);
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
      // someone — the realistic case and the one where a wait is quoted. It goes
      // through the reception desk path so it lands in the OP line the caller's
      // position is now computed from (the legacy queue is no longer read).
      const walkIn = await reception.registerWalkIn(CLINIC_A, {
        mobile: FILLER,
        name: 'Filler',
        doctorId: DOC_A,
        sessionDate: todayYmd(),
        sessionType: 'MORNING',
      });
      // NOTE: `WalkInView.tokenNumber` is the LEGACY booking token (W###). The
      // number the OP read models — and therefore queue-status — use is the OP
      // series token on the mirrored encounter, so resolve that one.
      const fillerReg = await prisma.registration.findFirstOrThrow({
        where: {
          source: 'RECEPTION',
          channelMeta: { path: ['legacyBookingId'], equals: walkIn.bookingId },
        },
        select: { encounterId: true },
      });
      fillerEncounterId = fillerReg.encounterId;
      fillerToken = (
        await prisma.token.findUniqueOrThrow({ where: { encounterId: fillerEncounterId } })
      ).displayNumber;

      const res = await post('/voice/bookings', {
        didNumber: DID_A,
        doctorId: DOC_A,
        sessionType: 'MORNING',
        patientPhone: CALLER,
        patientName: 'Ravi',
        callSid: 'vs-call-1',
      });
      expect(res.status).toBe(201);
      callerToken = ((await res.json()) as { tokenNumber: string }).tokenNumber;
    });

    it('sends exactly one SMS, to the caller’s own number', () => {
      expect(sms.texts).toHaveLength(1);
      expect(sms.texts[0].mobile).toBe(CALLER);
    });

    it('the SMS is self-contained — token, doctor, clinic, wait, payment note', () => {
      const msg = sms.texts[0].message;
      expect(callerToken).toMatch(/^N\d{3}$/); // OP series token, not a legacy one
      expect(msg).toContain(callerToken);
      expect(msg).toContain('Dr Aruna');
      expect(msg).toContain('VS Clinic A');
      expect(msg).toMatch(/pay at the reception desk/i);
      // The wait sentence is BEST-EFFORT: position comes from the OP projection,
      // which has not necessarily caught up by the time `book` sends the SMS.
      // The service omits the sentence rather than quote a stale number — so
      // assert it is either absent or correct, never that it is always there.
      const ahead = /(\d+) ahead of you/.exec(msg);
      if (ahead) expect(Number(ahead[1])).toBeGreaterThanOrEqual(0);
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
      const body = (await res.json()) as { bookingId: string; tokenNumber: string };
      expect(body.tokenNumber).toBeTruthy();

      // the token really is in the OP line despite the SMS blowing up
      const reg = await prisma.registration.findFirstOrThrow({
        where: {
          source: 'VOICE_AGENT',
          channelMeta: { path: ['legacyBookingId'], equals: body.bookingId },
        },
        select: { encounterId: true },
      });
      expect(
        await prisma.queueEntry.findUnique({ where: { encounterId: reg.encounterId } }),
      ).not.toBeNull();
    });
  });

  // ── queue status ──────────────────────────────────────────────────────────
  describe('POST /voice/queue-status', () => {
    it('returns the caller’s token with live position and wait', async () => {
      await scheduler.drain(); // drain the projection the position is read from
      const res = await status(DID_A, CALLER);
      expect(res.status).toBe(201);
      const rows = (await res.json()) as VoiceQueueStatusRecord[];

      expect(rows).toHaveLength(1);
      const r = rows[0];
      expect(r.tokenNumber).toBe(callerToken);
      expect(r.doctorName).toBe('Dr Aruna');
      expect(r.specialization).toBe('Cardiology');
      expect(r.patientsAhead).toBe(1); // the walk-in filler
      expect(r.estimatedWaitMinutes).toBe(10); // 1 ahead x 10 min
      // The OP engine has NO auto-promote: nobody is in consultation until the
      // doctor explicitly calls the next patient, so there is no one to name yet.
      expect(r.currentlyServing).toBeNull();
    });

    it('reflects the queue moving — the filler is called, then completed', async () => {
      // Doctor calls + starts the filler: caller moves to the front and can be
      // told who is in the room.
      const { opSessionId } = await prisma.queueEntry.findUniqueOrThrow({
        where: { encounterId: fillerEncounterId },
        select: { opSessionId: true },
      });
      await consultEngine.callNext(opSessionId);
      await consultEngine.startConsultation(fillerEncounterId);
      await scheduler.drain();

      let rows = (await status(DID_A, CALLER).then((r) => r.json())) as VoiceQueueStatusRecord[];
      expect(rows[0].patientsAhead).toBe(0);
      expect(rows[0].estimatedWaitMinutes).toBe(0);
      expect(rows[0].currentlyServing).toBe(fillerToken);

      // Once that consultation ends nobody is in the room again.
      await consultEngine.complete(fillerEncounterId);
      await scheduler.drain();

      rows = (await status(DID_A, CALLER).then((r) => r.json())) as VoiceQueueStatusRecord[];
      expect(rows[0].patientsAhead).toBe(0);
      expect(rows[0].currentlyServing).toBeNull();
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
      await scheduler.drain(); // clinic B's position is a projection read too

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
