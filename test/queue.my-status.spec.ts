import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { BookingSource, BookingStatus } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';

/**
 * GET /queue/my-status — patient-facing live position for their own booking.
 * Proves: serving token + patientsAhead are reported, a booking that left the
 * queue reads "done", another patient's booking is 403, and the route is
 * PATIENT-only.
 */
describe('Queue my-status (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;
  let queue: QueueService;

  const CLINIC = 'ms-clinic';
  const DOCTOR = 'ms-doctor';
  const P1 = 'ms-pt-1';
  const P2 = 'ms-pt-2';
  const date = '2026-06-22';
  const session: SessionKey = { doctorId: DOCTOR, sessionDate: date, sessionType: 'MORNING' };

  let booking1 = '';
  let token1 = '';
  let booking2 = '';
  let p1Token = '';
  let p2Token = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);
    queue = app.get(QueueService);

    await cleanup();
    await prisma.clinic.create({ data: { id: CLINIC, name: 'MS Clinic' } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'Dr MS' } });

    const r1 = await enqueue(P1, 'Asha');
    booking1 = r1.bookingId;
    token1 = r1.token;
    const r2 = await enqueue(P2, 'Bilal');
    booking2 = r2.bookingId;

    p1Token = tokens.sign({ sub: P1, role: 'PATIENT' });
    p2Token = tokens.sign({ sub: P2, role: 'PATIENT' });
  });

  afterAll(async () => {
    await queue.clearSession(session);
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await queue.clearSession(session);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } });
    await prisma.patient.deleteMany({ where: { id: { in: [P1, P2] } } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC } });
  }

  async function enqueue(id: string, name: string): Promise<{ bookingId: string; token: string }> {
    await prisma.patient.create({ data: { id, name, mobile: `8${Date.now()}${id.slice(-1)}` } });
    const booking = await prisma.booking.create({
      data: {
        patientId: id,
        doctorId: DOCTOR,
        source: BookingSource.APP,
        sessionDate: new Date(date),
        sessionType: 'MORNING',
        status: BookingStatus.BOOKED,
      },
    });
    const entry = await queue.enqueue(TokenSource.APP, session, booking.id);
    await prisma.booking.update({ where: { id: booking.id }, data: { tokenNumber: entry.tokenNumber } });
    return { bookingId: booking.id, token: entry.tokenNumber };
  }

  function myStatus(token: string, bookingId?: string) {
    const q = bookingId ? `?bookingId=${bookingId}` : '';
    return fetch(`${url}/queue/my-status${q}`, {
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('front patient sees themselves in consultation with the serving token = their own', async () => {
    const res = await myStatus(p1Token, booking1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      tokenNumber: string;
      servingToken: string | null;
      patientsAhead: number;
      position: number;
      status: string;
    };
    expect(body.tokenNumber).toBe(token1);
    expect(body.servingToken).toBe(token1); // front of queue
    expect(body.patientsAhead).toBe(0);
    expect(body.position).toBe(1);
    expect(body.status).toBe('in_consultation');
  });

  it('second patient is "next" with one ahead', async () => {
    const res = await myStatus(p2Token, booking2);
    const body = (await res.json()) as { patientsAhead: number; status: string; servingToken: string | null };
    expect(body.patientsAhead).toBe(1);
    expect(body.status).toBe('next');
    expect(body.servingToken).toBe(token1);
  });

  it('a token removed from the queue reads terminal "done"', async () => {
    await queue.removeToken(token1, session);
    const res = await myStatus(p1Token, booking1);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; patientsAhead: number };
    expect(body.status).toBe('done');
    expect(body.patientsAhead).toBe(0);
    // re-enqueue so independent ordering is restored for any later run
  });

  it('cannot read another patient booking (403)', async () => {
    const res = await myStatus(p2Token, booking1); // P2 asking for P1 booking
    expect(res.status).toBe(403);
  });

  it('role guard: no token -> 401, staff -> 403', async () => {
    const noAuth = await fetch(`${url}/queue/my-status?bookingId=${booking2}`);
    expect(noAuth.status).toBe(401);

    const staff = tokens.sign({ sub: 'ms-staff', role: 'STAFF', clinicId: CLINIC });
    const asStaff = await myStatus(staff, booking2);
    expect(asStaff.status).toBe(403);
  });
});
