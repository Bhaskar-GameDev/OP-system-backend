import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { BookingSource, BookingStatus, SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * Reception check-in (Arrived/Not Arrived). Clinic-scoped from the JWT, STAFF/
 * ADMIN only. Purely informational — sets/clears checked_in_at, never touches
 * the queue. Proves cross-clinic 403 and idempotent set/clear.
 */
describe('Reception check-in (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;

  const CLINIC_A = 'rc-clinic-a';
  const CLINIC_B = 'rc-clinic-b';
  const DOCTOR_A = 'rc-doc-a';
  const DOCTOR_B = 'rc-doc-b';
  const PATIENT = 'rc-patient';
  let bookingA = ''; // belongs to Clinic A
  let bookingB = ''; // belongs to Clinic B

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
    await prisma.doctor.createMany({
      data: [
        { id: DOCTOR_A, clinicId: CLINIC_A, name: 'Dr A' },
        { id: DOCTOR_B, clinicId: CLINIC_B, name: 'Dr B' },
      ],
    });
    await prisma.patient.create({ data: { id: PATIENT, name: 'P', mobile: '8000000099' } });

    const mk = (doctorId: string) =>
      prisma.booking.create({
        data: {
          patientId: PATIENT,
          doctorId,
          source: BookingSource.APP,
          sessionDate: new Date('2026-06-21'),
          sessionType: SessionType.MORNING,
          status: BookingStatus.BOOKED,
        },
      });
    bookingA = (await mk(DOCTOR_A)).id;
    bookingB = (await mk(DOCTOR_B)).id;

    staffAToken = tokens.sign({ sub: 'staff-a', role: 'STAFF', clinicId: CLINIC_A });
    staffBToken = tokens.sign({ sub: 'staff-b', role: 'STAFF', clinicId: CLINIC_B });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.booking.deleteMany({ where: { doctorId: { in: [DOCTOR_A, DOCTOR_B] } } });
    await prisma.patient.deleteMany({ where: { id: PATIENT } });
    await prisma.doctor.deleteMany({ where: { id: { in: [DOCTOR_A, DOCTOR_B] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } });
  }

  function checkin(bookingId: string, arrived: boolean, token: string) {
    return fetch(`${url}/reception/bookings/${bookingId}/checkin`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ arrived }),
    });
  }

  it('GET /reception/doctors returns only the caller clinic doctors, no secrets', async () => {
    const res = await fetch(`${url}/reception/doctors`, {
      headers: { authorization: `Bearer ${staffAToken}` },
    });
    expect(res.status).toBe(200);
    const list = (await res.json()) as Array<Record<string, unknown>>;
    expect(list.map((d) => d.id)).toEqual([DOCTOR_A]); // not DOCTOR_B (other clinic)
    expect(list[0]).toHaveProperty('avgConsultMinutes');
    expect(list[0]).not.toHaveProperty('username');
    expect(list[0]).not.toHaveProperty('passwordHash');

    const noAuth = await fetch(`${url}/reception/doctors`);
    expect(noAuth.status).toBe(401);
  });

  it('GET /reception/bookings returns the session roster, clinic-scoped, no PII beyond name', async () => {
    // a PENDING_PAYMENT booking must NOT appear (no token, not a real patient yet)
    const pending = await prisma.booking.create({
      data: {
        patientId: PATIENT,
        doctorId: DOCTOR_A,
        source: BookingSource.APP,
        sessionDate: new Date('2026-06-21'),
        sessionType: SessionType.MORNING,
        status: BookingStatus.PENDING_PAYMENT,
      },
      select: { id: true },
    });

    const q = `doctorId=${DOCTOR_A}&sessionDate=2026-06-21&sessionType=MORNING`;
    const res = await fetch(`${url}/reception/bookings?${q}`, {
      headers: { authorization: `Bearer ${staffAToken}` },
    });
    expect(res.status).toBe(200);
    const roster = (await res.json()) as Array<Record<string, unknown>>;
    expect(roster.map((r) => r.bookingId)).toContain(bookingA);
    expect(roster.map((r) => r.bookingId)).not.toContain(pending.id);
    const row = roster.find((r) => r.bookingId === bookingA);
    expect(row).toMatchObject({ patientName: 'P', status: 'BOOKED', arrived: false });
    expect(row).not.toHaveProperty('mobile');
    expect(row).not.toHaveProperty('patientId');

    // cross-clinic: Clinic B staff cannot read Clinic A's doctor roster
    const cross = await fetch(`${url}/reception/bookings?${q}`, {
      headers: { authorization: `Bearer ${staffBToken}` },
    });
    expect(cross.status).toBe(403);

    // 401 without a token
    const noAuth = await fetch(`${url}/reception/bookings?${q}`);
    expect(noAuth.status).toBe(401);

    await prisma.booking.delete({ where: { id: pending.id } });
  });

  it('roster reflects arrival after a check-in toggle', async () => {
    await checkin(bookingA, true, staffAToken);
    const q = `doctorId=${DOCTOR_A}&sessionDate=2026-06-21&sessionType=MORNING`;
    const res = await fetch(`${url}/reception/bookings?${q}`, {
      headers: { authorization: `Bearer ${staffAToken}` },
    });
    const roster = (await res.json()) as Array<Record<string, unknown>>;
    const row = roster.find((r) => r.bookingId === bookingA);
    expect(row?.arrived).toBe(true);
    expect(row?.checkedInAt).not.toBeNull();
    await checkin(bookingA, false, staffAToken); // reset for the idempotency test
  });

  it('cross-clinic: Clinic B staff gets 403 checking in Clinic A booking (real id)', async () => {
    const res = await checkin(bookingA, true, staffBToken);
    expect(res.status).toBe(403);
    // untouched
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingA } });
    expect(b.checkedInAt).toBeNull();
  });

  it('requires STAFF/ADMIN: no token -> 401, patient -> 403', async () => {
    const noAuth = await fetch(`${url}/reception/bookings/${bookingA}/checkin`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ arrived: true }),
    });
    expect(noAuth.status).toBe(401);

    const patientToken = tokens.sign({ sub: PATIENT, role: 'PATIENT' });
    const asPatient = await checkin(bookingA, true, patientToken);
    expect(asPatient.status).toBe(403);
  });

  it('set then clear works idempotently; never touches queue', async () => {
    // set arrived
    const r1 = await checkin(bookingA, true, staffAToken);
    expect(r1.status).toBe(200);
    const v1 = (await r1.json()) as { arrived: boolean; checkedInAt: string | null };
    expect(v1.arrived).toBe(true);
    expect(v1.checkedInAt).not.toBeNull();
    const firstStamp = v1.checkedInAt;

    // set again (idempotent) — preserves the ORIGINAL arrival time
    const r2 = await checkin(bookingA, true, staffAToken);
    const v2 = (await r2.json()) as { arrived: boolean; checkedInAt: string | null };
    expect(v2.arrived).toBe(true);
    expect(v2.checkedInAt).toBe(firstStamp);

    // clear
    const r3 = await checkin(bookingA, false, staffAToken);
    const v3 = (await r3.json()) as { arrived: boolean; checkedInAt: string | null };
    expect(v3.arrived).toBe(false);
    expect(v3.checkedInAt).toBeNull();

    // clear again (idempotent)
    const r4 = await checkin(bookingA, false, staffAToken);
    const v4 = (await r4.json()) as { arrived: boolean; checkedInAt: string | null };
    expect(v4.arrived).toBe(false);
    expect(v4.checkedInAt).toBeNull();

    // DB reflects final state; booking status untouched (no queue side effects)
    const b = await prisma.booking.findUniqueOrThrow({ where: { id: bookingA } });
    expect(b.checkedInAt).toBeNull();
    expect(b.status).toBe(BookingStatus.BOOKED);
  });
});
