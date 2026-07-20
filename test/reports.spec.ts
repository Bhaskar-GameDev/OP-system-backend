import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { PaymentStatus } from '@prisma/client';

/**
 * Operational reports (admin/staff analytics dashboard). Exercises the SQL
 * aggregation over BOTH the live bookings table and the archived booking_history
 * so the UNION source is validated, plus clinic scope, role access and the CSV
 * export. Money is in paise; CSV reports rupees.
 */
describe('Operational reports (/admin/reports)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;

  // CLINIC and OTHER live in DIFFERENT hospitals so the hospital-scoped ADMIN
  // report over CLINIC's hospital provably excludes OTHER's bookings.
  const HOSPITAL = 'rpt-hosp';
  const OTHER_HOSPITAL = 'rpt-hosp-other';
  const CLINIC = 'rpt-clinic';
  const OTHER = 'rpt-clinic-other';
  const DOC_A = 'rpt-doc-a';
  const DOC_B = 'rpt-doc-b';
  const DOC_OTHER = 'rpt-doc-other';
  const PT = 'rpt-pt';
  let adminToken = '';
  let staffToken = '';
  let doctorToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);

    await cleanup();
    await prisma.hospital.createMany({
      data: [
        { id: HOSPITAL, name: 'Reports Hospital' },
        { id: OTHER_HOSPITAL, name: 'Other Hospital' },
      ],
    });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC, hospitalId: HOSPITAL, name: 'Reports Clinic' },
        { id: OTHER, hospitalId: OTHER_HOSPITAL, name: 'Other Clinic' },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        { id: DOC_A, clinicId: CLINIC, name: 'Dr Alpha', consultationFee: 500 },
        { id: DOC_B, clinicId: CLINIC, name: 'Dr Beta', consultationFee: 300 },
        { id: DOC_OTHER, clinicId: OTHER, name: 'Dr Other', consultationFee: 700 },
      ],
    });
    await prisma.patient.create({ data: { id: PT, name: 'Rpt Patient', mobile: '9100000099' } });

    const day = (s: string) => new Date(`${s}T00:00:00.000Z`);
    const at = (s: string) => new Date(s);

    // ── Live bookings on 2026-06-20 ──
    // Online completed, seen 20m after booking, ₹500 paid.
    await prisma.booking.create({
      data: {
        id: 'rpt-b1',
        patientId: PT,
        doctorId: DOC_A,
        source: 'APP',
        tokenNumber: 'A001',
        sessionDate: day('2026-06-20'),
        sessionType: 'MORNING',
        status: 'COMPLETED',
        createdAt: at('2026-06-20T09:00:00.000Z'),
        consultationStartedAt: at('2026-06-20T09:20:00.000Z'),
        consultationEndedAt: at('2026-06-20T09:30:00.000Z'),
      },
    });
    await prisma.payment.create({
      data: { id: 'rpt-pay1', bookingId: 'rpt-b1', amount: 50000, status: PaymentStatus.SUCCESS },
    });
    await prisma.booking.update({ where: { id: 'rpt-b1' }, data: { paymentId: 'rpt-pay1' } });
    // Walk-in, booked but not seen, no payment.
    await prisma.booking.create({
      data: {
        id: 'rpt-b2',
        patientId: PT,
        doctorId: DOC_B,
        source: 'WALK_IN',
        tokenNumber: 'W001',
        sessionDate: day('2026-06-20'),
        sessionType: 'MORNING',
        status: 'BOOKED',
        createdAt: at('2026-06-20T11:00:00.000Z'),
      },
    });
    // Another clinic's booking — must never appear in CLINIC's report.
    await prisma.booking.create({
      data: {
        id: 'rpt-b-other',
        patientId: PT,
        doctorId: DOC_OTHER,
        source: 'APP',
        tokenNumber: 'A001',
        sessionDate: day('2026-06-20'),
        sessionType: 'MORNING',
        status: 'COMPLETED',
        createdAt: at('2026-06-20T09:00:00.000Z'),
      },
    });
    await prisma.payment.create({
      data: { id: 'rpt-pay-other', bookingId: 'rpt-b-other', amount: 70000, status: PaymentStatus.SUCCESS },
    });
    await prisma.booking.update({ where: { id: 'rpt-b-other' }, data: { paymentId: 'rpt-pay-other' } });

    // ── Archived history on 2026-06-19 (settled, in booking_history) ──
    await prisma.bookingHistory.create({
      data: {
        id: 'rpt-h1',
        bookingId: 'rpt-old-1',
        patientId: PT,
        doctorId: DOC_A,
        clinicId: CLINIC,
        source: 'VOICE',
        tokenNumber: 'A001',
        sessionDate: day('2026-06-19'),
        sessionType: 'EVENING',
        finalStatus: 'COMPLETED',
        paymentAmount: 50000,
        paymentStatus: 'SUCCESS',
        bookedAt: at('2026-06-19T17:00:00.000Z'),
        consultationStartedAt: at('2026-06-19T17:10:00.000Z'),
        consultationEndedAt: at('2026-06-19T17:25:00.000Z'),
      },
    });

    adminToken = tokens.sign({ sub: 'rpt-admin', role: 'ADMIN', clinicId: CLINIC, hospitalId: HOSPITAL });
    staffToken = tokens.sign({ sub: 'rpt-staff', role: 'STAFF', clinicId: CLINIC, hospitalId: HOSPITAL });
    doctorToken = tokens.sign({ sub: 'rpt-doctor', role: 'DOCTOR', doctorId: DOC_A, clinicId: CLINIC, hospitalId: HOSPITAL });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const clinics = [CLINIC, OTHER];
    await prisma.payment.deleteMany({ where: { id: { in: ['rpt-pay1', 'rpt-pay-other'] } } });
    await prisma.booking.deleteMany({ where: { doctorId: { in: [DOC_A, DOC_B, DOC_OTHER] } } });
    await prisma.bookingHistory.deleteMany({ where: { clinicId: { in: clinics } } });
    await prisma.doctor.deleteMany({ where: { clinicId: { in: clinics } } });
    await prisma.patient.deleteMany({ where: { id: PT } });
    await prisma.clinic.deleteMany({ where: { id: { in: clinics } } });
    await prisma.hospital.deleteMany({ where: { id: { in: [HOSPITAL, OTHER_HOSPITAL] } } });
  }

  function get(path: string, token = adminToken) {
    return fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it('summary aggregates live bookings + archived history, clinic-scoped', async () => {
    const res = await get('/admin/reports/summary?from=2026-06-19&to=2026-06-20');
    expect(res.status).toBe(200);
    const body = await res.json();

    // 3 in-clinic events (b1, b2, h1). The other clinic's booking is excluded.
    expect(body.totals.total).toBe(3);
    expect(body.totals.online).toBe(2); // APP + VOICE
    expect(body.totals.walkIn).toBe(1);
    expect(body.totals.completed).toBe(2);
    expect(body.totals.revenuePaise).toBe(100000); // 500 + 500 (success only)
    // avg wait over the two seen rows: (20 + 10) / 2 = 15 minutes
    expect(body.totals.avgWaitMinutes).toBe(15);

    // trend has a point per day, oldest first
    expect(body.trend.map((t: { bucket: string }) => t.bucket)).toEqual([
      '2026-06-19',
      '2026-06-20',
    ]);

    // busiest doctor first; Dr Alpha has 2 events, Dr Beta 1
    expect(body.doctors[0].name).toBe('Dr Alpha');
    expect(body.doctors[0].bookings).toBe(2);
    expect(body.doctors[0].sessions).toBe(2); // (06-19,EVENING) + (06-20,MORNING)

    // peak hours include 09:00 (booking creation hour, UTC)
    const nine = body.peakHours.find((p: { hour: number }) => p.hour === 9);
    expect(nine?.total).toBe(1);
  });

  it('date filter narrows the range', async () => {
    const res = await get('/admin/reports/summary?from=2026-06-20&to=2026-06-20');
    const body = await res.json();
    expect(body.totals.total).toBe(2); // only the 06-20 live rows
  });

  it('STAFF may read reports; DOCTOR is forbidden', async () => {
    expect((await get('/admin/reports/summary', staffToken)).status).toBe(200);
    expect((await get('/admin/reports/summary', doctorToken)).status).toBe(403);
  });

  it('CSV export returns rupees and a row per in-clinic booking', async () => {
    const res = await get('/admin/reports/export?from=2026-06-19&to=2026-06-20');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    const csv = await res.text();
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toContain('session_date,doctor,source,status');
    expect(lines.length).toBe(4); // header + 3 rows
    expect(csv).toContain('Dr Alpha');
    expect(csv).toContain('500.00'); // paise -> rupees
    expect(csv).not.toContain('Dr Other');
  });
});
