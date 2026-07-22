import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import {
  BookingSource,
  BookingStatus,
  EncounterStatus,
  SessionType,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { OpConfigService } from '../src/config-engine/op-config.service';

/**
 * Patient live-status read cutover (reversible, flagged). `GET /queue/my-status`
 * serves from the new engine when the clinic is flipped AND the patient's
 * encounter is in the new queue; otherwise it falls back to legacy. The patient
 * app is unchanged (same MyQueueStatus shape).
 */
describe('Patient /queue/my-status read cutover', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let config: OpConfigService;

  const stamp = Date.now();
  const HOSP = `ps-hosp-${stamp}`;
  const CLINIC = `ps-clinic-${stamp}`;
  const DOCTOR = `ps-doc-${stamp}`;
  const SERIES = `ps-series-${stamp}`;
  const SESS = `ps-sess-${stamp}`;
  const BOOKING = `ps-bk-${stamp}`;
  const BOOKING_NONEW = `ps-bk-nonew-${stamp}`;
  const MOBILE = '7900000001';
  const DATE = new Date();
  let patientTok = '';
  let patientId = '';
  const encIds: string[] = [];

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
    config = app.get(OpConfigService);

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'PS Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'PS Clinic' } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'PS Dr', avgConsultMinutes: 8 } });
    await prisma.tokenSeries.create({ data: { id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'N', prefix: 'N', padWidth: 3 } });
    const patient = await prisma.patient.create({ data: { mobile: MOBILE, name: 'PS Patient' } });
    patientId = patient.id;
    patientTok = app.get(AuthTokenService).sign({ sub: patientId, role: 'PATIENT' });

    // Legacy bookings the patient app knows about (distinct tokens per session).
    const bookingTokens: Record<string, string> = { [BOOKING]: 'N002', [BOOKING_NONEW]: 'N009' };
    for (const id of [BOOKING, BOOKING_NONEW]) {
      await prisma.booking.create({
        data: { id, patientId, doctorId: DOCTOR, source: BookingSource.APP, sessionDate: new Date(todayYmd()), sessionType: SessionType.MORNING, status: BookingStatus.BOOKED, tokenNumber: bookingTokens[id] },
      });
    }

    // New-engine queue: SERVING (in consult) + AHEAD (waiting) + ME (waiting, = BOOKING).
    const serving = await mkEnc('N001', EncounterStatus.IN_CONSULTATION, null);
    const ahead = await mkEnc('N0015', EncounterStatus.WAITING, 1);
    const me = await mkEnc('N002', EncounterStatus.WAITING, 2, BOOKING);
    // ME is correlated to the legacy booking so my-status can resolve it.
    void serving; void ahead; void me;
  });

  async function mkEnc(token: string, status: EncounterStatus, orderKey: number | null, legacyBookingId?: string) {
    const enc = await prisma.encounter.create({
      data: { patientId, hospitalId: HOSP, clinicId: CLINIC, doctorId: DOCTOR, serviceDate: DATE, opCategoryId: SERIES, status, legacyBookingId: legacyBookingId ?? null },
    });
    encIds.push(enc.id);
    await prisma.queueReadModel.create({
      data: { encounterId: enc.id, clinicId: CLINIC, doctorId: DOCTOR, opSessionId: SESS, patientName: 'PS Patient', tokenNumber: token, category: 'NORMAL_OP', status, orderKey },
    });
    return enc.id;
  }

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.hospitalConfig.deleteMany({ where: { scopeId: CLINIC } }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: { in: [BOOKING, BOOKING_NONEW] } } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: MOBILE } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  function myStatus(bookingId: string) {
    return fetch(`${url}/queue/my-status?bookingId=${encodeURIComponent(bookingId)}`, {
      headers: { authorization: `Bearer ${patientTok}` },
    });
  }

  it('flag OFF (default): uses the legacy path (empty legacy queue -> done)', async () => {
    const res = await myStatus(BOOKING);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('done'); // legacy eta finds no live token
  });

  it('flag ON + encounter in the new queue: serves new-engine position', async () => {
    await config.set('CLINIC', CLINIC, 'reads.cutover.patientStatus', true);
    const res = await myStatus(BOOKING);
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      tokenNumber: string; servingToken: string | null; patientsAhead: number;
      position: number; total: number; etaMinutes: number; status: string;
    };
    expect(b.tokenNumber).toBe('N002');
    expect(b.patientsAhead).toBe(1); // one WAITING ahead (N0015)
    expect(b.position).toBe(2);
    expect(b.servingToken).toBe('N001'); // the IN_CONSULTATION token
    expect(b.total).toBe(3); // 2 waiting + 1 in consultation
    expect(b.etaMinutes).toBe(8); // patientsAhead(1) * avgConsultMinutes(8)
    expect(b.status).toBe('next');
  });

  it('flag ON but encounter NOT in the new queue: falls back to legacy', async () => {
    const res = await myStatus(BOOKING_NONEW);
    expect(res.status).toBe(200);
    const b = (await res.json()) as { status: string };
    expect(b.status).toBe('done'); // no new-engine read model row -> legacy path
  });
});
