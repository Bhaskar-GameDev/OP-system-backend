process.env.VOICE_INTERNAL_SECRET = process.env.VOICE_INTERNAL_SECRET ?? 'test-voice-secret';

import { ConflictException, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EncounterStatus, SessionType, TokenResetPolicy } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { VoiceService } from '../src/voice/voice.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';

/**
 * VOICE channel (voice.book) against the OP engine.
 *
 * Post-cutover contract (2026-07-26): the agent raises the OP token AT BOOKING,
 * so the mirror runs the FULL combined path (`present: true`) — register ->
 * check-in -> issue token -> enqueue — exactly like the reception desk. The OP
 * `displayNumber` is authoritative: it is what the caller is told, what the SMS
 * carries, and what the doctor/reception read models render. The legacy Booking
 * survives only as the correlation + refund/audit anchor and has the OP token
 * copied onto it.
 *
 * (This replaces the pre-cutover contract, where voice mirrored REGISTER-ONLY
 * and the token was deferred to desk check-in.)
 */
describe('voice.book raises an OP token into the new engine', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let voice: VoiceService;
  let queue: QueueService;

  const stamp = Date.now();
  const HOSP = `mv-hosp-${stamp}`;
  const CLINIC = `mv-clinic-${stamp}`;
  const DOCTOR = `mv-doc-${stamp}`;
  const SERIES = `mv-series-${stamp}`;
  const DID = `+9100000${String(stamp).slice(-5)}`;
  const PHONE = '9300009991';
  const PHONE_NO_SERIES = '9300009992';
  const CALLSID = `mv-call-${stamp}`;
  const encounterIds: string[] = [];

  const todayYmd = (): string => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  let session: SessionKey;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    prisma = app.get(PrismaService);
    voice = app.get(VoiceService);
    queue = app.get(QueueService);
    session = { doctorId: DOCTOR, sessionDate: todayYmd(), sessionType: 'MORNING' };

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'MV Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'MV Clinic' } });
    await prisma.voiceNumber.create({ data: { didNumber: DID, clinicId: CLINIC } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'MV Dr', specialization: 'GP', consultationFee: 400, avgConsultMinutes: 10 } });
    await prisma.doctorSession.create({ data: { doctorId: DOCTOR, sessionType: SessionType.MORNING, startTime: '09:00', maxTokens: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] } });
    await prisma.tokenSeries.create({
      data: { id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'Normal', prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION },
    });
  });

  afterAll(async () => {
    await queue.clearSession(session).catch(() => {});
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const w = { encounterId: { in: encounterIds } };
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => {});
    await prisma.token.deleteMany({ where: w }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: w }).catch(() => {});
    await prisma.registration.deleteMany({ where: w }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: w }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encounterIds } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.voiceCallLog.deleteMany({ where: { callSid: CALLSID } }).catch(() => {});
    const bs = await prisma.booking.findMany({ where: { doctorId: DOCTOR }, select: { id: true } }).catch(() => [] as { id: string }[]);
    await prisma.booking.updateMany({ where: { doctorId: DOCTOR }, data: { paymentId: null } }).catch(() => {});
    await prisma.payment.deleteMany({ where: { bookingId: { in: bs.map((b) => b.id) } } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: { in: [PHONE, PHONE_NO_SERIES] } } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.voiceNumber.deleteMany({ where: { clinicId: CLINIC } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  it('a VOICE booking issues an OP token and enqueues (source VOICE_AGENT)', async () => {
    const res = await voice.book({
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING',
      patientPhone: PHONE, patientName: 'Voice Caller', callSid: CALLSID,
    });

    const reg = await prisma.registration.findFirst({
      where: { source: 'VOICE_AGENT', channelMeta: { path: ['legacyBookingId'], equals: res.bookingId } },
      select: { encounterId: true },
    });
    expect(reg).not.toBeNull();
    encounterIds.push(reg!.encounterId);

    // FULL combined path: checked in, token issued, sitting in the queue.
    const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: reg!.encounterId } });
    expect(enc.status).toBe(EncounterStatus.WAITING);

    const token = await prisma.token.findUnique({ where: { encounterId: reg!.encounterId } });
    expect(token).not.toBeNull();
    expect(await prisma.queueEntry.findUnique({ where: { encounterId: reg!.encounterId } })).not.toBeNull();

    // The OP displayNumber is what the caller is quoted — from the seeded
    // NORMAL_OP series (prefix N, padWidth 3, startAt 1).
    expect(token!.displayNumber).toBe('N001');
    expect(res.tokenNumber).toBe(token!.displayNumber);

    // ...and it is mirrored onto the legacy booking so lookup/cancel read one number.
    const legacy = await prisma.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
    expect(legacy.tokenNumber).toBe(token!.displayNumber);
    expect(legacy.payAtDesk).toBe(true);
  });

  it('rejects rather than confirming a token-less booking when no series exists', async () => {
    // Without a TokenSeries the mirror cannot raise a token. OP is authoritative,
    // so there is nothing to quote — the agent must re-offer, not confirm a phantom.
    await prisma.tokenSeries.delete({ where: { id: SERIES } });
    try {
      await expect(
        voice.book({
          didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING',
          patientPhone: PHONE_NO_SERIES, patientName: 'No Series', callSid: `${CALLSID}-ns`,
        }),
      ).rejects.toThrow(ConflictException);
    } finally {
      await prisma.tokenSeries.create({
        data: { id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'Normal', prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION },
      });
    }
  });

  it('is idempotent on callSid — a retried call maps to the same Encounter', async () => {
    const res = await voice.book({
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING',
      patientPhone: PHONE, patientName: 'Voice Caller', callSid: CALLSID, // same callSid
    });
    // same legacy booking, and exactly one mirrored encounter for this callSid
    const regs = await prisma.registration.findMany({
      where: { source: 'VOICE_AGENT', channelMeta: { path: ['legacyBookingId'], equals: res.bookingId } },
    });
    expect(regs).toHaveLength(1);
  });
});
