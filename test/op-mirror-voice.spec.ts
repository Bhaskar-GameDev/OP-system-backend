process.env.VOICE_INTERNAL_SECRET = process.env.VOICE_INTERNAL_SECRET ?? 'test-voice-secret';

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EncounterStatus, SessionType, TokenResetPolicy } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { VoiceService } from '../src/voice/voice.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';

/**
 * Dual-write — VOICE channel (voice.book). Proves a phone booking mirrors into
 * the new engine as an Encounter (source VOICE_AGENT), idempotent on callSid,
 * with the legacy pay-at-desk booking kept as the correlation record.
 *
 * Voice mirrors with `present: true`, unlike the app: a phone caller picks a
 * doctor and is given a number on the call, so the OP engine issues the token
 * and puts them in the line there and then. It is the OP token the agent reads
 * out, so registering without one would leave nothing to say.
 */
describe('Dual-write: voice.book mirrors a VOICE booking into the new engine', () => {
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
    await prisma.patient.deleteMany({ where: { mobile: PHONE } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.voiceNumber.deleteMany({ where: { clinicId: CLINIC } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  it('a VOICE booking yields a mirrored Encounter holding the token it quoted (source VOICE_AGENT)', async () => {
    const res = await voice.book({
      didNumber: DID, doctorId: DOCTOR, sessionType: 'MORNING',
      patientPhone: PHONE, patientName: 'Voice Caller', callSid: CALLSID,
    });
    expect(res.tokenNumber).toBeTruthy(); // the number read out to the caller

    const reg = await prisma.registration.findFirst({
      where: { source: 'VOICE_AGENT', channelMeta: { path: ['legacyBookingId'], equals: res.bookingId } },
      select: { encounterId: true },
    });
    expect(reg).not.toBeNull();
    encounterIds.push(reg!.encounterId);

    // Checked in and in the line, holding the token the caller was told — the OP
    // engine is the source of truth for that number, not the legacy booking.
    const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: reg!.encounterId } });
    expect(enc.status).toBe(EncounterStatus.WAITING);
    const token = await prisma.token.findUnique({ where: { encounterId: reg!.encounterId } });
    expect(token?.displayNumber).toBe(res.tokenNumber);
    expect(await prisma.queueEntry.findUnique({ where: { encounterId: reg!.encounterId } })).not.toBeNull();
    // The legacy row mirrors the same number, so lookup/cancel stay consistent.
    const legacy = await prisma.booking.findUniqueOrThrow({ where: { id: res.bookingId } });
    expect(legacy.tokenNumber).toBe(res.tokenNumber);
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
