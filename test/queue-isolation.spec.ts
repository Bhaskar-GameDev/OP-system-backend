import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { BookingSource, BookingStatus, SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * Queue-control + payment ownership isolation.
 *
 * `/queue/*` and `/payments/*` take doctorId / bookingId / patientId straight from
 * the request, so role alone is not authorization. This proves the scope gate:
 *   - a DOCTOR may act only on their OWN queue,
 *   - STAFF only within their clinic, ADMIN only within their hospital,
 *   - a PATIENT may only cancel/book for themselves.
 * Companion to tenant-isolation.spec (which covers admin CRUD / audit / reports /
 * Socket.io).
 */
describe('Queue + payment scope isolation (real infra)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;

  const HOSP_A = 'qi-hosp-a';
  const HOSP_B = 'qi-hosp-b';
  const CLINIC_A1 = 'qi-clinic-a1';
  const CLINIC_A2 = 'qi-clinic-a2'; // 2nd clinic in hospital A -> admin spans both
  const CLINIC_B1 = 'qi-clinic-b1';
  const DOC_A1 = 'qi-doc-a1';
  const DOC_A2 = 'qi-doc-a2';
  const DOC_B = 'qi-doc-b';
  const PT_A = 'qi-pt-a';
  const PT_B = 'qi-pt-b';
  const DATE = '2026-06-20';

  let doctorA1 = '';
  let doctorB = '';
  let staffA1 = '';
  let adminA = '';
  let patientA = '';
  let patientB = '';
  let bookingAId = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    const tokens = app.get(AuthTokenService);

    await cleanup();
    await prisma.hospital.createMany({
      data: [
        { id: HOSP_A, name: 'QI Hospital A' },
        { id: HOSP_B, name: 'QI Hospital B' },
      ],
    });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A1, hospitalId: HOSP_A, name: 'A1' },
        { id: CLINIC_A2, hospitalId: HOSP_A, name: 'A2' },
        { id: CLINIC_B1, hospitalId: HOSP_B, name: 'B1' },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        { id: DOC_A1, clinicId: CLINIC_A1, name: 'Dr A1' },
        { id: DOC_A2, clinicId: CLINIC_A2, name: 'Dr A2' },
        { id: DOC_B, clinicId: CLINIC_B1, name: 'Dr B' },
      ],
    });
    await prisma.patient.createMany({
      data: [
        { id: PT_A, name: 'Pat A', mobile: '9310000001' },
        { id: PT_B, name: 'Pat B', mobile: '9310000002' },
      ],
    });
    const bookingA = await prisma.booking.create({
      data: {
        patientId: PT_A, doctorId: DOC_A1, source: BookingSource.APP,
        sessionDate: new Date(DATE), sessionType: SessionType.MORNING,
        status: BookingStatus.BOOKED, tokenNumber: 'A001',
      },
      select: { id: true },
    });
    bookingAId = bookingA.id;

    doctorA1 = tokens.sign({ sub: DOC_A1, role: 'DOCTOR', doctorId: DOC_A1, clinicId: CLINIC_A1, hospitalId: HOSP_A });
    doctorB = tokens.sign({ sub: DOC_B, role: 'DOCTOR', doctorId: DOC_B, clinicId: CLINIC_B1, hospitalId: HOSP_B });
    staffA1 = tokens.sign({ sub: 'qi-staff-a1', role: 'STAFF', clinicId: CLINIC_A1, hospitalId: HOSP_A });
    adminA = tokens.sign({ sub: 'qi-admin-a', role: 'ADMIN', clinicId: CLINIC_A1, hospitalId: HOSP_A });
    patientA = tokens.sign({ sub: PT_A, role: 'PATIENT' });
    patientB = tokens.sign({ sub: PT_B, role: 'PATIENT' });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const docs = [DOC_A1, DOC_A2, DOC_B];
    const clinics = [CLINIC_A1, CLINIC_A2, CLINIC_B1];
    await prisma.auditLog.deleteMany({ where: { doctorId: { in: docs } } });
    await prisma.booking.deleteMany({ where: { doctorId: { in: docs } } });
    await prisma.doctor.deleteMany({ where: { id: { in: docs } } });
    await prisma.patient.deleteMany({ where: { id: { in: [PT_A, PT_B] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: clinics } } });
    await prisma.hospital.deleteMany({ where: { id: { in: [HOSP_A, HOSP_B] } } });
  }

  const listQueue = (token: string, doctorId: string) =>
    fetch(`${url}/queue/list?doctorId=${doctorId}&sessionDate=${DATE}&sessionType=MORNING`, {
      headers: { authorization: `Bearer ${token}` },
    });
  const noShow = (token: string, doctorId: string) =>
    fetch(`${url}/queue/no-show`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ doctorId, sessionDate: DATE, sessionType: 'MORNING', token: 'A001' }),
    });

  // ── cross-doctor ─────────────────────────────────────────────────────────
  it('a DOCTOR cannot read or mutate another doctor’s queue (403)', async () => {
    expect((await listQueue(doctorA1, DOC_B)).status).toBe(403);
    expect((await noShow(doctorA1, DOC_B)).status).toBe(403);
    // even a doctor in the SAME hospital is off-limits — own queue only
    expect((await listQueue(doctorA1, DOC_A2)).status).toBe(403);
    expect((await noShow(doctorA1, DOC_A2)).status).toBe(403);
  });

  it('a DOCTOR can act on their own queue', async () => {
    const res = await listQueue(doctorA1, DOC_A1);
    expect(res.status).toBe(200);
    expect(Array.isArray(await res.json())).toBe(true);
  });

  // ── cross-tenant (staff) ─────────────────────────────────────────────────
  it('Hospital A STAFF cannot touch a Hospital B doctor’s queue', async () => {
    expect([403, 404]).toContain((await listQueue(staffA1, DOC_B)).status);
    expect([403, 404]).toContain((await noShow(staffA1, DOC_B)).status);
  });

  it('STAFF is clinic-scoped: cannot touch a sibling clinic in their own hospital', async () => {
    expect([403, 404]).toContain((await listQueue(staffA1, DOC_A2)).status);
  });

  it('STAFF can act within their own clinic', async () => {
    expect((await listQueue(staffA1, DOC_A1)).status).toBe(200);
  });

  // ── cross-tenant (admin) ─────────────────────────────────────────────────
  it('Hospital A ADMIN cannot touch a Hospital B doctor’s queue', async () => {
    expect([403, 404]).toContain((await listQueue(adminA, DOC_B)).status);
    expect([403, 404]).toContain((await noShow(adminA, DOC_B)).status);

    const docB = await prisma.doctor.findUniqueOrThrow({ where: { id: DOC_B } });
    expect(docB.name).toBe('Dr B'); // untouched
  });

  it('ADMIN spans every clinic in their OWN hospital', async () => {
    expect((await listQueue(adminA, DOC_A1)).status).toBe(200);
    expect((await listQueue(adminA, DOC_A2)).status).toBe(200); // sibling clinic
  });

  // ── payments: ownership ──────────────────────────────────────────────────
  it('a PATIENT cannot cancel another patient’s booking (404, no existence leak)', async () => {
    const res = await fetch(`${url}/payments/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${patientB}`, 'content-type': 'application/json' },
      body: JSON.stringify({ bookingId: bookingAId }),
    });
    expect(res.status).toBe(404);

    const still = await prisma.booking.findUniqueOrThrow({ where: { id: bookingAId } });
    expect(still.status).toBe(BookingStatus.BOOKED); // not cancelled
  });

  it('a PATIENT cannot initiate a booking for someone else (403)', async () => {
    const res = await fetch(`${url}/payments/booking`, {
      method: 'POST',
      headers: { authorization: `Bearer ${patientA}`, 'content-type': 'application/json' },
      body: JSON.stringify({ patientId: PT_B, doctorId: DOC_A1, source: 'APP' }),
    });
    expect(res.status).toBe(403);
  });

  it('Hospital A staff cannot initiate a booking against a Hospital B doctor', async () => {
    const res = await fetch(`${url}/payments/booking`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staffA1}`, 'content-type': 'application/json' },
      body: JSON.stringify({ patientId: PT_A, doctorId: DOC_B, source: 'WALK_IN' }),
    });
    expect([403, 404]).toContain(res.status);
  });
});
