// Voice secret MUST be set before the app (ConfigModule) boots.
process.env.VOICE_INTERNAL_SECRET = 'test-voice-secret';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { CheckInMethod, RegistrationSource, SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { SMS_SENDER, SmsSender } from '../src/auth/sms.sender';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';
import { EncounterService } from '../src/encounters/encounter.service';
import { CheckInService } from '../src/check-in/checkin.service';
import { OpQueueService } from '../src/queue/op-queue.service';
import { ConsultationEngineService } from '../src/consultation/consultation-engine.service';
import { ProjectionRunner } from '../src/read-side/projection-runner.service';
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
  let redis: RedisService;
  let queue: QueueService;
  let encounters: EncounterService;
  let checkIn: CheckInService;
  let opQueue: OpQueueService;
  let engine: ConsultationEngineService;
  let projection: ProjectionRunner;
  const sms = new FakeSms();

  /** Clinic A's OP line + the walk-in filler holding W001 on it. */
  let opSessionA = '';
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
  // OP categories. Clinic A runs two so the walk-in filler keeps its own W
  // series and the voice caller still reads A001 off the clinic default.
  const SERIES_A = 'vs-series-a';
  const SERIES_A_WALKIN = 'vs-series-a-walkin';
  const SERIES_B = 'vs-series-b';

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
    redis = app.get(RedisService);
    queue = app.get(QueueService);
    encounters = app.get(EncounterService);
    checkIn = app.get(CheckInService);
    opQueue = app.get(OpQueueService);
    engine = app.get(ConsultationEngineService);
    projection = app.get(ProjectionRunner);

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
    // The OP engine renders every token from a TokenSeries and refuses to
    // register without one, so both clinics need a default. NORMAL_OP is the
    // one voice bookings fall back to; the W series is only for the filler.
    await prisma.tokenSeries.createMany({
      data: [
        { id: SERIES_A, clinicId: CLINIC_A, code: 'NORMAL_OP', label: 'Normal OP', prefix: 'A', padWidth: 3, startAt: 1 },
        { id: SERIES_A_WALKIN, clinicId: CLINIC_A, code: 'WALK_IN', label: 'Walk-in', prefix: 'W', padWidth: 3, startAt: 1 },
        { id: SERIES_B, clinicId: CLINIC_B, code: 'NORMAL_OP', label: 'Normal OP', prefix: 'B', padWidth: 3, startAt: 1 },
      ],
    });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  /** Encounter ids the OP engine holds for either doctor in this fixture. */
  async function opEncounterIds(): Promise<string[]> {
    const rows = await prisma.encounter
      .findMany({ where: { doctorId: { in: [DOC_A, DOC_B] } }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    return rows.map((r) => r.id);
  }

  async function cleanup(): Promise<void> {
    await queue.clearSession(sessionA);
    await queue.clearSession(sessionB);
    // OP side owns the tokens and the live line now; clear its rows and the
    // Redis token counters, or a rerun starts counting at A002 / W002.
    const eids = await opEncounterIds();
    await prisma.consultation.deleteMany({ where: { encounterId: { in: eids } } }).catch(() => undefined);
    await prisma.queueEntry.deleteMany({ where: { encounterId: { in: eids } } }).catch(() => undefined);
    await prisma.token.deleteMany({ where: { encounterId: { in: eids } } }).catch(() => undefined);
    await prisma.checkIn.deleteMany({ where: { encounterId: { in: eids } } }).catch(() => undefined);
    await prisma.registration.deleteMany({ where: { encounterId: { in: eids } } }).catch(() => undefined);
    await prisma.queueReadModel.deleteMany({ where: { encounterId: { in: eids } } }).catch(() => undefined);
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: eids } } }).catch(() => undefined);
    await prisma.encounter.deleteMany({ where: { id: { in: eids } } }).catch(() => undefined);
    await prisma.opSession.deleteMany({ where: { doctorId: { in: [DOC_A, DOC_B] } } }).catch(() => undefined);
    // PER_SESSION counter keys — see TokenSeriesService.counterKey.
    const day = todayYmd();
    for (const [series, doctorId] of [
      [SERIES_A, DOC_A],
      [SERIES_A_WALKIN, DOC_A],
      [SERIES_B, DOC_B],
    ]) {
      await redis.redis.del(`pfos:tokenseq:${series}:${doctorId}:${day}`).catch(() => undefined);
    }
    await prisma.tokenSeries
      .deleteMany({ where: { id: { in: [SERIES_A, SERIES_A_WALKIN, SERIES_B] } } })
      .catch(() => undefined);
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

  // queue-status reads the CQRS read model, which the scheduler drains on a 2s
  // tick. Pull that forward instead of sleeping, so the assertions see the line
  // as it stands right now.
  const status = async (did: string, phone: string) => {
    await projection.runOnce();
    return post('/voice/queue-status', { didNumber: did, patientPhone: phone });
  };

  // ── booking confirmation SMS ───────────────────────────────────────────────
  describe('booking confirmation SMS', () => {
    beforeAll(async () => {
      sms.reset();
      // A walk-in filler takes W001 first, so the voice caller lands behind
      // someone — the realistic case and the one where a wait is quoted. It goes
      // through the OP engine (register -> check in -> enqueue), the same
      // primitives the reception desk uses and the line /voice/queue-status reads.
      const fillerEnc = await encounters.register({
        source: RegistrationSource.RECEPTION,
        doctorId: DOC_A,
        mobile: FILLER,
        name: 'Filler',
        serviceDate: todayYmd(),
        opCategoryId: SERIES_A_WALKIN,
      });
      fillerEncounterId = fillerEnc.id;
      await checkIn.checkIn(fillerEnc.id, CheckInMethod.AUTO, { issueToken: true });
      opSessionA = (await opQueue.enqueue(fillerEnc.id)).opSessionId;

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

      // token really is in the live OP line despite the SMS blowing up
      const waiting = await opQueue.listWaiting(opSessionA);
      const tokens = await prisma.token.findMany({
        where: { encounterId: { in: waiting.map((w) => w.encounterId) } },
        select: { displayNumber: true },
      });
      expect(tokens.map((t) => t.displayNumber)).toContain(body.tokenNumber);
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
      expect(r.patientsAhead).toBe(1); // the walk-in filler, still waiting
      expect(r.estimatedWaitMinutes).toBe(10); // 1 ahead x 10 min
      expect(r.currentlyServing).toBeNull(); // nobody called into the room yet
    });

    it('reflects the queue moving — position and wait drop as the filler is seen', async () => {
      // Filler is called and goes in: they leave the waiting line, so the
      // caller's wait drops to zero and the board names who is inside.
      const called = await engine.callNext(opSessionA);
      expect(called?.encounter.id).toBe(fillerEncounterId);
      await engine.startConsultation(fillerEncounterId);

      let rows = (await status(DID_A, CALLER).then((r) => r.json())) as VoiceQueueStatusRecord[];
      expect(rows[0].patientsAhead).toBe(0);
      expect(rows[0].estimatedWaitMinutes).toBe(0);
      expect(rows[0].currentlyServing).toBe('W001');

      // Filler done, caller called in — now they are the one being served.
      await engine.complete(fillerEncounterId);
      const next = await engine.callNext(opSessionA);
      await engine.startConsultation(next!.encounter.id);

      rows = (await status(DID_A, CALLER).then((r) => r.json())) as VoiceQueueStatusRecord[];
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
