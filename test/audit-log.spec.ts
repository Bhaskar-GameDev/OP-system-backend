import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { SessionType, StaffRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * GET /audit-log — read surface for the compliance trail. Proves: clinic
 * scoping (STAFF sees only their clinic), action filter, newest-first +
 * limit/offset pagination, staff/patient name enrichment, and that patients are
 * rejected by the role guard.
 */
describe('Audit log read API (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;

  const CLINIC_A = 'al-clinic-a';
  const CLINIC_B = 'al-clinic-b';
  const DOCTOR_A = 'al-doctor-a';
  const STAFF_A = 'al-staff-a';
  const PATIENT = 'al-patient';
  let bookingId = '';

  let staffAToken = '';
  let staffBToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);

    await cleanup();
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A, name: 'Clinic A' },
        { id: CLINIC_B, name: 'Clinic B' },
      ],
    });
    await prisma.doctor.create({ data: { id: DOCTOR_A, clinicId: CLINIC_A, name: 'Dr A' } });
    await prisma.staff.create({
      data: {
        id: STAFF_A,
        clinicId: CLINIC_A,
        name: 'Reception A',
        role: StaffRole.RECEPTIONIST,
        loginCredentials: 'x',
      },
    });
    await prisma.patient.create({ data: { id: PATIENT, name: 'Asha Rao', mobile: '9000000123' } });
    const booking = await prisma.booking.create({
      data: {
        patientId: PATIENT,
        doctorId: DOCTOR_A,
        source: 'APP',
        sessionDate: new Date('2026-06-20'),
        sessionType: SessionType.MORNING,
        status: 'BOOKED',
        tokenNumber: 'A001',
      },
    });
    bookingId = booking.id;

    // 5 rows in Clinic A (3 DONE, 2 SKIP), 1 row in Clinic B — increasing createdAt
    const base = Date.parse('2026-06-20T08:00:00.000Z');
    const rows = [
      { action: 'DONE', token: 'A001', bookingId, i: 0 },
      { action: 'SKIP', token: 'A002', bookingId: null, i: 1 },
      { action: 'DONE', token: 'A003', bookingId: null, i: 2 },
      { action: 'SKIP', token: 'A004', bookingId: null, i: 3 },
      { action: 'DONE', token: 'A005', bookingId: null, i: 4 },
    ];
    for (const r of rows) {
      await prisma.auditLog.create({
        data: {
          actorId: STAFF_A,
          actorRole: 'STAFF',
          clinicId: CLINIC_A,
          action: r.action,
          doctorId: DOCTOR_A,
          sessionDate: new Date('2026-06-20'),
          sessionType: SessionType.MORNING,
          token: r.token,
          bookingId: r.bookingId,
          createdAt: new Date(base + r.i * 60_000),
        },
      });
    }
    await prisma.auditLog.create({
      data: {
        actorId: 'al-staff-b',
        actorRole: 'STAFF',
        clinicId: CLINIC_B,
        action: 'DONE',
        doctorId: 'al-doctor-b',
        sessionDate: new Date('2026-06-20'),
        sessionType: SessionType.MORNING,
        token: 'B001',
        createdAt: new Date(base + 99 * 60_000),
      },
    });

    // STAFF audit scope is by clinicId; hospitalId is required by the tenant
    // guard (present on every real staff token) but does not widen STAFF scope.
    staffAToken = tokens.sign({ sub: STAFF_A, role: 'STAFF', clinicId: CLINIC_A, hospitalId: 'al-hosp' });
    staffBToken = tokens.sign({ sub: 'al-staff-b', role: 'STAFF', clinicId: CLINIC_B, hospitalId: 'al-hosp' });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.auditLog.deleteMany({ where: { clinicId: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_A } });
    await prisma.patient.deleteMany({ where: { id: PATIENT } });
    await prisma.staff.deleteMany({ where: { id: STAFF_A } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_A } });
    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } });
  }

  function list(token: string, query = '') {
    return fetch(`${url}/audit-log${query}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it('clinic-scoped, newest-first, with staff + patient name enrichment', async () => {
    const res = await list(staffAToken);
    expect(res.status).toBe(200);
    const page = (await res.json()) as {
      total: number;
      entries: Array<{
        token: string;
        action: string;
        staffName: string | null;
        patientName: string | null;
        doctorName: string | null;
      }>;
    };
    // only Clinic A's 5 rows — never Clinic B's B001
    expect(page.total).toBe(5);
    expect(page.entries.map((e) => e.token)).not.toContain('B001');
    // newest-first: A005 (latest createdAt) leads
    expect(page.entries[0].token).toBe('A005');
    // enrichment resolved at read time
    expect(page.entries[0].staffName).toBe('Reception A');
    expect(page.entries[0].doctorName).toBe('Dr A');
    // the DONE on A001 carries the patient name via its bookingId
    const a001 = page.entries.find((e) => e.token === 'A001');
    expect(a001?.patientName).toBe('Asha Rao');
  });

  it('filters by action', async () => {
    const page = (await (await list(staffAToken, '?action=DONE')).json()) as {
      total: number;
      entries: Array<{ action: string }>;
    };
    expect(page.total).toBe(3);
    expect(page.entries.every((e) => e.action === 'DONE')).toBe(true);
  });

  it('rejects an invalid action filter (400)', async () => {
    expect((await list(staffAToken, '?action=BOGUS')).status).toBe(400);
  });

  it('paginates with limit/offset while reporting full total', async () => {
    const p1 = (await (await list(staffAToken, '?limit=2&offset=0')).json()) as {
      total: number;
      entries: Array<{ token: string }>;
    };
    expect(p1.total).toBe(5);
    expect(p1.entries.map((e) => e.token)).toEqual(['A005', 'A004']);

    const p2 = (await (await list(staffAToken, '?limit=2&offset=2')).json()) as {
      entries: Array<{ token: string }>;
    };
    expect(p2.entries.map((e) => e.token)).toEqual(['A003', 'A002']);
  });

  it('rejects a bad limit (400)', async () => {
    expect((await list(staffAToken, '?limit=0')).status).toBe(400);
    expect((await list(staffAToken, '?limit=999')).status).toBe(400);
  });

  it('Clinic B staff never sees Clinic A rows', async () => {
    const page = (await (await list(staffBToken)).json()) as {
      total: number;
      entries: Array<{ token: string }>;
    };
    expect(page.total).toBe(1);
    expect(page.entries[0].token).toBe('B001');
  });

  it('role guard: no token -> 401, patient -> 403', async () => {
    expect((await fetch(`${url}/audit-log`)).status).toBe(401);
    const patient = tokens.sign({ sub: PATIENT, role: 'PATIENT' });
    expect((await list(patient)).status).toBe(403);
  });
});
