import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { BookingSource, BookingStatus, SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { AnalyticsService } from '../src/admin/analytics.service';

/**
 * Admin Portal — token-scoped CRUD + the daily analytics summary job.
 *
 * Proves (1) clinic scope is derived from the TOKEN, not request params: an
 * admin from Clinic A cannot touch Clinic B's doctor even when passing Clinic
 * B's real id; and (2) the summary job counts COMPLETED/NO_SHOW correctly and
 * EXCLUDES non-completed rows from the wait/consult averages.
 */
describe('Admin Portal (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;
  let analytics: AnalyticsService;

  const HOSPITAL = 'admin-hosp';
  const CLINIC_A = 'admin-clinic-a';
  const CLINIC_B = 'admin-clinic-b';
  const DOCTOR_A = 'admin-doc-a';
  const DOCTOR_B = 'admin-doc-b';

  let adminAToken = '';

  // Fixed clock: summary runs "today" and summarizes YESTERDAY's history.
  const NOW = new Date('2026-06-20T06:00:00.000Z'); // 6am, after the 2:30am job
  const YESTERDAY = new Date(Date.UTC(2026, 5, 19)); // session day being summarized
  const TODAY = new Date(Date.UTC(2026, 5, 20)); // same-day rows must NOT be folded in

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;

    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);
    analytics = app.get(AnalyticsService);

    await cleanup();

    await prisma.hospital.upsert({
      where: { id: HOSPITAL },
      update: {},
      create: { id: HOSPITAL, name: 'Admin Hospital' },
    });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A, hospitalId: HOSPITAL, name: 'Clinic A' },
        { id: CLINIC_B, hospitalId: HOSPITAL, name: 'Clinic B' },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        { id: DOCTOR_A, clinicId: CLINIC_A, name: 'Dr A' },
        { id: DOCTOR_B, clinicId: CLINIC_B, name: 'Dr B' },
      ],
    });

    // ADMIN token for Clinic A — clinicId is the home clinic; hospitalId is the
    // tenant scope. Doctor CRUD stays clinic-scoped (A cannot touch B's doctor).
    adminAToken = tokens.sign({ sub: 'admin-a-staff', role: 'ADMIN', clinicId: CLINIC_A, hospitalId: HOSPITAL });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.bookingHistory.deleteMany({ where: { clinicId: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.analyticsDaily.deleteMany({ where: { clinicId: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.doctor.deleteMany({ where: { clinicId: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.staff.deleteMany({ where: { clinicId: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.hospital.deleteMany({ where: { id: HOSPITAL } });
  }

  function adminFetch(path: string, init: RequestInit = {}, token = adminAToken) {
    return fetch(`${url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
  }

  it('scope is token-derived: Clinic A admin gets 403 editing Clinic B doctor (real id)', async () => {
    // passing Clinic B's REAL doctor id — must NOT be honoured
    const res = await adminFetch(`/admin/doctors/${DOCTOR_B}`, {
      method: 'PATCH',
      body: JSON.stringify({ name: 'Hijacked' }),
    });
    expect(res.status).toBe(403);

    // and even echoing Clinic B's real id in the body cannot switch scope
    const res2 = await adminFetch(`/admin/doctors`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Sneaky', clinicId: CLINIC_B }),
    });
    expect(res2.status).toBe(403);

    // untouched
    const docB = await prisma.doctor.findUniqueOrThrow({ where: { id: DOCTOR_B } });
    expect(docB.name).toBe('Dr B');
  });

  it('admin can CRUD within own clinic; password hash never leaks', async () => {
    const created = await adminFetch(`/admin/doctors`, {
      method: 'POST',
      body: JSON.stringify({ name: 'Dr New', username: 'dr.new', password: 'secretpass', consultationFee: 400 }),
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as Record<string, unknown>;
    expect(body.clinicId).toBe(CLINIC_A); // forced from token, not body
    expect(body.username).toBe('dr.new');
    // serialized response carries NO password material
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('secretpass');
    expect(raw).not.toContain('passwordHash');
    expect(raw).not.toContain('password_hash');

    // but it WAS persisted (hashed), so login would work
    const persisted = await prisma.doctor.findUniqueOrThrow({ where: { id: body.id as string } });
    expect(persisted.passwordHash).toBeTruthy();
    expect(persisted.passwordHash).not.toBe('secretpass');

    await prisma.doctor.delete({ where: { id: body.id as string } });
  });

  it('analytics read endpoint requires ADMIN (patient -> 403, none -> 401)', async () => {
    const noAuth = await fetch(`${url}/admin/analytics?from=2026-06-19&to=2026-06-20`);
    expect(noAuth.status).toBe(401);

    const patientToken = tokens.sign({ sub: 'p1', role: 'PATIENT' });
    const asPatient = await adminFetch(`/admin/analytics?from=2026-06-19`, {}, patientToken);
    expect(asPatient.status).toBe(403);
  });

  it('daily summary: counts COMPLETED/NO_SHOW; excludes non-completed from averages', async () => {
    // Yesterday @ Clinic A:
    //  - 2 COMPLETED with real timestamps (waits 10 & 30 -> avg 20; consults 5 & 15 -> avg 10)
    //  - 1 NO_SHOW (no timestamps)
    //  - 1 CANCELLED (no timestamps)
    // A same-day (TODAY) COMPLETED row must be IGNORED by yesterday's summary.
    const booked = new Date(Date.UTC(2026, 5, 19, 9, 0, 0));
    await prisma.bookingHistory.createMany({
      data: [
        {
          bookingId: 'h-c1', patientId: 'p1', doctorId: DOCTOR_A, clinicId: CLINIC_A,
          source: BookingSource.APP, sessionDate: YESTERDAY, sessionType: SessionType.MORNING,
          finalStatus: BookingStatus.COMPLETED, bookedAt: booked,
          consultationStartedAt: new Date(Date.UTC(2026, 5, 19, 9, 10, 0)), // wait 10m
          consultationEndedAt: new Date(Date.UTC(2026, 5, 19, 9, 15, 0)), // consult 5m
        },
        {
          bookingId: 'h-c2', patientId: 'p2', doctorId: DOCTOR_A, clinicId: CLINIC_A,
          source: BookingSource.APP, sessionDate: YESTERDAY, sessionType: SessionType.MORNING,
          finalStatus: BookingStatus.COMPLETED, bookedAt: booked,
          consultationStartedAt: new Date(Date.UTC(2026, 5, 19, 9, 30, 0)), // wait 30m
          consultationEndedAt: new Date(Date.UTC(2026, 5, 19, 9, 45, 0)), // consult 15m
        },
        {
          bookingId: 'h-ns', patientId: 'p3', doctorId: DOCTOR_A, clinicId: CLINIC_A,
          source: BookingSource.WALK_IN, sessionDate: YESTERDAY, sessionType: SessionType.MORNING,
          finalStatus: BookingStatus.NO_SHOW, bookedAt: booked,
        },
        {
          bookingId: 'h-cx', patientId: 'p4', doctorId: DOCTOR_A, clinicId: CLINIC_A,
          source: BookingSource.APP, sessionDate: YESTERDAY, sessionType: SessionType.MORNING,
          finalStatus: BookingStatus.CANCELLED, bookedAt: booked,
        },
        {
          bookingId: 'h-today', patientId: 'p5', doctorId: DOCTOR_A, clinicId: CLINIC_A,
          source: BookingSource.APP, sessionDate: TODAY, sessionType: SessionType.MORNING,
          finalStatus: BookingStatus.COMPLETED, bookedAt: new Date(Date.UTC(2026, 5, 20, 9, 0, 0)),
          consultationStartedAt: new Date(Date.UTC(2026, 5, 20, 9, 5, 0)),
          consultationEndedAt: new Date(Date.UTC(2026, 5, 20, 9, 50, 0)),
        },
      ],
    });

    const { clinics } = await analytics.runDailySummary(NOW);
    expect(clinics).toBe(1);

    // Read endpoint serves ONLY analytics_daily — verify via the HTTP surface.
    const res = await adminFetch(`/admin/analytics/daily?date=2026-06-19`);
    expect(res.status).toBe(200);
    const row = (await res.json()) as {
      clinicId: string; patientsSeen: number; noShows: number; avgWaitTime: number; avgConsultTime: number;
    };
    expect(row.clinicId).toBe(CLINIC_A);
    expect(row.patientsSeen).toBe(2); // 2 COMPLETED, the same-day one excluded
    expect(row.noShows).toBe(1); // CANCELLED is NOT a no-show
    expect(row.avgWaitTime).toBe(20); // (10+30)/2 — NO_SHOW/CANCELLED not folded as 0
    expect(row.avgConsultTime).toBe(10); // (5+15)/2

    // idempotent re-run overwrites the same row, doesn't double-count
    await analytics.runDailySummary(NOW);
    const again = await (await adminFetch(`/admin/analytics/daily?date=2026-06-19`)).json();
    expect((again as { patientsSeen: number }).patientsSeen).toBe(2);
  });
});
