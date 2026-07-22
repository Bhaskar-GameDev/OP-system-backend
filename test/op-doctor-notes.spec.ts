import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import {
  BookingSource,
  BookingStatus,
  ConsultationState,
  EncounterStatus,
  RegistrationSource,
  SessionType,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * Op-mode doctor notes + completed list. Notes are keyed by encounterId over
 * HTTP but stored against the encounter's linked legacy bookingId (reusing the
 * existing note storage). The completed list is sourced from completed encounters.
 */
describe('Op doctor console — completed list + encounter-keyed notes', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;

  const stamp = Date.now();
  const HOSP = `od-hosp-${stamp}`;
  const CLINIC = `od-clinic-${stamp}`;
  const DOCTOR = `od-doc-${stamp}`;
  const OTHER = `od-doc2-${stamp}`;
  const SERIES = `od-series-${stamp}`;
  const BOOKING = `od-bk-${stamp}`;
  const DATE = new Date(`${new Date().getFullYear()}-01-15T00:00:00.000Z`);
  const MOBILE = '7100000009';
  let docTok = '';
  let otherTok = '';
  let encId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    const tokens = app.get(AuthTokenService);
    docTok = tokens.sign({ sub: DOCTOR, role: 'DOCTOR', doctorId: DOCTOR, clinicId: CLINIC, hospitalId: HOSP });
    otherTok = tokens.sign({ sub: OTHER, role: 'DOCTOR', doctorId: OTHER, clinicId: CLINIC, hospitalId: HOSP });

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'OD Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'OD Clinic' } });
    await prisma.doctor.createMany({ data: [
      { id: DOCTOR, clinicId: CLINIC, name: 'OD Dr', avgConsultMinutes: 10 },
      { id: OTHER, clinicId: CLINIC, name: 'OD Other', avgConsultMinutes: 10 },
    ] });
    await prisma.tokenSeries.create({ data: { id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'N', prefix: 'N', padWidth: 3 } });
    const patient = await prisma.patient.create({ data: { mobile: MOBILE, name: 'OD Patient' } });

    // A COMPLETED encounter linked to a legacy booking (dual-write correlation).
    await prisma.booking.create({ data: { id: BOOKING, patientId: patient.id, doctorId: DOCTOR, source: BookingSource.APP, sessionDate: DATE, sessionType: SessionType.MORNING, status: BookingStatus.COMPLETED, tokenNumber: 'N001' } });
    const enc = await prisma.encounter.create({ data: { patientId: patient.id, hospitalId: HOSP, clinicId: CLINIC, doctorId: DOCTOR, serviceDate: DATE, opCategoryId: SERIES, status: EncounterStatus.COMPLETED, legacyBookingId: BOOKING } });
    encId = enc.id;
    await prisma.registration.create({ data: { encounterId: encId, source: RegistrationSource.APP } });
    await prisma.token.create({ data: { encounterId: encId, seriesId: SERIES, sequence: 1, displayNumber: 'N001' } });
    await prisma.consultation.create({ data: { encounterId: encId, doctorId: DOCTOR, state: ConsultationState.COMPLETED, startedAt: DATE, endedAt: DATE } });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.consultationNote.deleteMany({ where: { bookingId: BOOKING } }).catch(() => {});
    const ids = (await prisma.encounter.findMany({ where: { doctorId: { in: [DOCTOR, OTHER] } }, select: { id: true } }).catch(() => [] as { id: string }[])).map((e) => e.id);
    await prisma.consultation.deleteMany({ where: { encounterId: { in: ids } } }).catch(() => {});
    await prisma.token.deleteMany({ where: { encounterId: { in: ids } } }).catch(() => {});
    await prisma.registration.deleteMany({ where: { encounterId: { in: ids } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { doctorId: { in: [DOCTOR, OTHER] } } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { id: BOOKING } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: MOBILE } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: { in: [DOCTOR, OTHER] } } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  const get = (path: string, tok: string) => fetch(`${url}${path}`, { headers: { authorization: `Bearer ${tok}` } });
  const post = (path: string, tok: string, body: unknown) => fetch(`${url}${path}`, { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('lists the completed encounter (no note yet)', async () => {
    const res = await get(`/op/doctors/${DOCTOR}/completed`, docTok);
    expect(res.status).toBe(200);
    const rows = (await res.json()) as { encounterId: string; bookingId: string; tokenNumber: string; hasNote: boolean }[];
    const row = rows.find((r) => r.encounterId === encId);
    expect(row).toBeDefined();
    expect(row!.bookingId).toBe(encId); // console keys notes by encounterId
    expect(row!.tokenNumber).toBe('N001');
    expect(row!.hasNote).toBe(false);
  });

  it('saves and reads a note by encounterId (stored against the linked booking)', async () => {
    const save = await post(`/op/encounters/${encId}/note`, docTok, { notes: 'BP high', diagnosis: 'HTN', followUpDate: '2026-02-01' });
    expect(save.status).toBe(201);

    const read = await get(`/op/encounters/${encId}/note`, docTok);
    expect(read.status).toBe(200);
    const note = (await read.json()) as { notes: string; diagnosis: string | null; followUpDate: string | null };
    expect(note.notes).toBe('BP high');
    expect(note.diagnosis).toBe('HTN');
    expect(note.followUpDate).toBe('2026-02-01');

    // it landed on the linked legacy booking's note row (reused storage)
    const stored = await prisma.consultationNote.findUnique({ where: { bookingId: BOOKING } });
    expect(stored?.notes).toBe('BP high');

    // completed list now reflects the note
    const rows = (await (await get(`/op/doctors/${DOCTOR}/completed`, docTok)).json()) as { encounterId: string; hasNote: boolean }[];
    expect(rows.find((r) => r.encounterId === encId)?.hasNote).toBe(true);
  });

  it('refuses a note on another doctor\'s encounter', async () => {
    const res = await post(`/op/encounters/${encId}/note`, otherTok, { notes: 'x' });
    expect(res.status).toBe(403);
  });
});
