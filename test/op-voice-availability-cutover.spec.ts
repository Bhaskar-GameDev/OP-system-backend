import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { EncounterStatus, SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { OpConfigService } from '../src/config-engine/op-config.service';
import { VoiceService } from '../src/voice/voice.service';

/**
 * Voice availability read cutover (reversible, flagged). When a clinic is flipped,
 * `VoiceService.availability` quotes the doctor's live wait from the NEW engine's
 * read model instead of the legacy queue. Aggregate count only — no per-caller
 * token, so no phone-token-vs-desk-token divergence. Default off = legacy.
 */
describe('Voice availability read cutover', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let config: OpConfigService;
  let voice: VoiceService;

  const stamp = Date.now();
  const HOSP = `va-hosp-${stamp}`;
  const CLINIC = `va-clinic-${stamp}`;
  const DOCTOR = `va-doc-${stamp}`;
  const DID = `+9100${String(stamp).slice(-7)}`;
  const encIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
    prisma = app.get(PrismaService);
    config = app.get(OpConfigService);
    voice = app.get(VoiceService);

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'VA Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'VA Clinic' } });
    await prisma.voiceNumber.create({ data: { didNumber: DID, clinicId: CLINIC } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'VA Dr', specialization: 'GP', consultationFee: 300, avgConsultMinutes: 10 } });
    await prisma.doctorSession.create({ data: { doctorId: DOCTOR, sessionType: SessionType.MORNING, startTime: '09:00', maxTokens: 20, daysOfWeek: [0, 1, 2, 3, 4, 5, 6] } });

    // Two patients WAITING in the NEW engine (legacy queue stays empty).
    for (let i = 0; i < 2; i++) {
      const p = await prisma.patient.create({ data: { mobile: `61${stamp}${i}`, name: `VA P${i}` } });
      const enc = await prisma.encounter.create({
        data: { patientId: p.id, hospitalId: HOSP, clinicId: CLINIC, doctorId: DOCTOR, serviceDate: new Date(), opCategoryId: 'x', status: EncounterStatus.WAITING },
      });
      encIds.push(enc.id);
      await prisma.queueReadModel.create({
        data: { encounterId: enc.id, clinicId: CLINIC, doctorId: DOCTOR, opSessionId: `va-sess-${stamp}`, patientName: `VA P${i}`, tokenNumber: `N00${i + 1}`, status: EncounterStatus.WAITING, orderKey: i + 1 },
      });
    }
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.hospitalConfig.deleteMany({ where: { scopeId: CLINIC } }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: { startsWith: `61${stamp}` } } }).catch(() => {});
    await prisma.doctorSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.voiceNumber.deleteMany({ where: { clinicId: CLINIC } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  function waitingFor(res: { doctors: { doctorId: string; sessions: { waiting: number }[] }[] }): number | undefined {
    return res.doctors.find((d) => d.doctorId === DOCTOR)?.sessions[0]?.waiting;
  }

  it('flag OFF (default): quotes the legacy queue size (0 here)', async () => {
    const res = await voice.availability({ didNumber: DID });
    expect(waitingFor(res)).toBe(0);
  });

  it('flag ON: quotes the new engine live queue (2 waiting)', async () => {
    await config.set('CLINIC', CLINIC, 'reads.cutover.voiceAvailability', true);
    const res = await voice.availability({ didNumber: DID });
    expect(waitingFor(res)).toBe(2);
  });
});
