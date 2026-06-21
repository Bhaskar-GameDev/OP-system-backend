import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { BookingSource, BookingStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';

/**
 * Walk-in registration (POST /reception/walkins) produces a REAL Booking — with
 * a real bookingId, a patient row, and a live-queue token — identical in every
 * downstream respect to an app booking. Proves the bookingId is usable for
 * check-in and for no-show / skip / priority / reinsert.
 */
describe('Reception walk-in registration (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;
  let queue: QueueService;

  const CLINIC_A = 'wi-clinic-a';
  const CLINIC_B = 'wi-clinic-b';
  const DOCTOR_A = 'wi-doc-a';
  const DOCTOR_B = 'wi-doc-b';
  const MOBILES = ['7100000001', '7100000002', '7100000003'];
  const session: SessionKey = {
    doctorId: DOCTOR_A,
    sessionDate: '2026-06-22',
    sessionType: 'MORNING',
  };

  let staffAToken = '';
  let staffBToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);
    queue = app.get(QueueService);

    await cleanup();
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A, name: 'WI Clinic A' },
        { id: CLINIC_B, name: 'WI Clinic B' },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        { id: DOCTOR_A, clinicId: CLINIC_A, name: 'WI Dr A', avgConsultMinutes: 10 },
        { id: DOCTOR_B, clinicId: CLINIC_B, name: 'WI Dr B' },
      ],
    });
    staffAToken = tokens.sign({ sub: 'wi-staff-a', role: 'STAFF', clinicId: CLINIC_A });
    staffBToken = tokens.sign({ sub: 'wi-staff-b', role: 'STAFF', clinicId: CLINIC_B });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await queue.clearSession(session);
    await prisma.booking.deleteMany({ where: { doctorId: { in: [DOCTOR_A, DOCTOR_B] } } });
    await prisma.patient.deleteMany({ where: { mobile: { in: MOBILES } } });
    await prisma.doctor.deleteMany({ where: { id: { in: [DOCTOR_A, DOCTOR_B] } } });
    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } });
  }

  interface WalkInView {
    bookingId: string;
    patientId: string;
    tokenNumber: string;
    status: string;
  }

  function walkin(mobile: string, name: string, token = staffAToken) {
    return fetch(`${url}/reception/walkins`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mobile, name, ...session }),
    });
  }

  function queueOp(path: string, body: Record<string, unknown>) {
    return fetch(`${url}/queue/${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staffAToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...session, ...body }),
    });
  }

  async function list(): Promise<string[]> {
    const res = await fetch(
      `${url}/queue/list?doctorId=${DOCTOR_A}&sessionDate=${session.sessionDate}&sessionType=MORNING`,
      { headers: { authorization: `Bearer ${staffAToken}` } },
    );
    const rows = (await res.json()) as Array<{ tokenNumber: string }>;
    return rows.map((r) => r.tokenNumber);
  }

  it('validates input and enforces clinic scope', async () => {
    const bad = await fetch(`${url}/reception/walkins`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staffAToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: '', name: '', ...session }),
    });
    expect(bad.status).toBe(400);

    // Clinic B staff cannot register against Clinic A's doctor
    const crossClinic = await walkin(MOBILES[0], 'Wrong Clinic', staffBToken);
    expect(crossClinic.status).toBe(403);

    const noAuth = await fetch(`${url}/reception/walkins`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: MOBILES[0], name: 'X', ...session }),
    });
    expect(noAuth.status).toBe(401);
  });

  it('registers a real Booking that flows through the full queue lifecycle', async () => {
    // 1. first walk-in lands at rank 0 -> promoted ACTIVE
    const ra = await walkin(MOBILES[0], 'Alice');
    expect(ra.status).toBe(201);
    const a = (await ra.json()) as WalkInView;
    expect(a.tokenNumber).toBe('W001');
    expect(a.status).toBe('ACTIVE');
    expect(a.bookingId).toBeTruthy();

    // real DB booking + patient
    const dbA = await prisma.booking.findUniqueOrThrow({ where: { id: a.bookingId } });
    expect(dbA.source).toBe(BookingSource.WALK_IN);
    expect(dbA.status).toBe(BookingStatus.ACTIVE);
    expect(dbA.tokenNumber).toBe('W001');
    expect(dbA.consultationStartedAt).not.toBeNull();
    const patient = await prisma.patient.findUniqueOrThrow({ where: { mobile: MOBILES[0] } });
    expect(patient.name).toBe('Alice');
    expect(patient.id).toBe(a.patientId);

    // appears in the live queue
    expect(await list()).toEqual(['W001']);

    // 2. second walk-in -> BOOKED, behind A
    const b = (await (await walkin(MOBILES[1], 'Bob')).json()) as WalkInView;
    expect(b.tokenNumber).toBe('W002');
    expect(b.status).toBe('BOOKED');
    expect(await list()).toEqual(['W001', 'W002']);

    // 3. check-in A using its bookingId (feature 4 path) — works like app booking
    const ci = await fetch(`${url}/reception/bookings/${a.bookingId}/checkin`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${staffAToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ arrived: true }),
    });
    expect(ci.status).toBe(200);
    expect((await ci.json()).arrived).toBe(true);

    // 4. SKIP A -> moves to back; result carries A's real bookingId
    const skip = await queueOp('skip', { token: 'W001' });
    expect(skip.status).toBe(201);
    expect((await skip.json()).skippedBookingId).toBe(a.bookingId);
    expect(await list()).toEqual(['W002', 'W001']);

    // 5. NO-SHOW A -> removed; result carries A's bookingId; DB marked NO_SHOW
    const ns = await queueOp('no-show', { token: 'W001' });
    expect(ns.status).toBe(201);
    expect((await ns.json()).noShowBookingId).toBe(a.bookingId);
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: a.bookingId } })).status).toBe(
      BookingStatus.NO_SHOW,
    );
    expect(await list()).toEqual(['W002']);

    // 6. REINSERT A after B using its bookingId -> back in queue
    const re = await queueOp('reinsert', {
      token: 'W001',
      afterToken: 'W002',
      bookingId: a.bookingId,
    });
    expect(re.status).toBe(201);
    expect(await list()).toEqual(['W002', 'W001']);

    // 7. PRIORITY using a walk-in's bookingId -> inserts a fresh token near front
    const c = (await (await walkin(MOBILES[2], 'Cara')).json()) as WalkInView;
    expect(c.tokenNumber).toBe('W003');
    await queueOp('no-show', { token: 'W003' }); // pull C out of the queue first
    const prio = await queueOp('priority', { bookingId: c.bookingId });
    expect(prio.status).toBe(201);
    const prioBody = (await prio.json()) as { token: string };
    // the priority token is now in the queue, just behind the active patient
    const after = await list();
    expect(after).toContain(prioBody.token);
    expect(after.indexOf(prioBody.token)).toBe(1);
  });
});
