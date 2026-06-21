import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { BookingStatus, BookingSource } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthService } from '../src/auth/auth.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { PasswordService } from '../src/auth/password.service';
import { SMS_SENDER, SmsSender } from '../src/auth/sms.sender';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';

/** Captures the OTP so the test can complete a REAL patient login flow. */
class CapturingSms implements SmsSender {
  last?: { mobile: string; otp: string };
  async sendOtp(mobile: string, otp: string): Promise<void> {
    this.last = { mobile, otp };
  }
}

/**
 * QE-12 re-verified against REAL Auth-Service tokens (not the old seam): patient
 * tokens minted via OTP login, doctor token via username/password login. Proves
 * a patient can't join another patient's channel, and reconnect yields an
 * immediate snapshot.
 */
describe('QueueGateway — real auth tokens (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let auth: AuthService;
  let consult: ConsultationService;
  let queue: QueueService;
  const sms = new CapturingSms();

  const CLINIC_ID = 'rt-clinic';
  const DOCTOR_ID = 'rt-doctor';
  const session: SessionKey = {
    doctorId: DOCTOR_ID,
    sessionDate: '2026-06-19',
    sessionType: 'MORNING',
  };

  const MOBILE_A = '9000000001';
  const MOBILE_B = '9000000002';
  let patientToken = '';
  let doctorToken = '';
  let staffToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SMS_SENDER)
      .useValue(sms)
      .compile();

    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    const port = (app.getHttpServer().address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;

    prisma = app.get(PrismaService);
    auth = app.get(AuthService);
    consult = app.get(ConsultationService);
    queue = app.get(QueueService);
    const passwords = app.get(PasswordService);

    await cleanup();

    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'RT Clinic' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: {
        id: DOCTOR_ID,
        clinicId: CLINIC_ID,
        name: 'Dr RT',
        avgConsultMinutes: 5,
        username: 'dr.rt',
        passwordHash: await passwords.hash('docpass'),
      },
      update: { username: 'dr.rt', passwordHash: await passwords.hash('docpass') },
    });

    // REAL patient logins via OTP
    const patientA = await loginPatient(MOBILE_A);
    patientToken = patientA.token;
    await loginPatient(MOBILE_B); // patient B exists too

    const idA = await prisma.patient.findUniqueOrThrow({ where: { mobile: MOBILE_A } });
    const idB = await prisma.patient.findUniqueOrThrow({ where: { mobile: MOBILE_B } });

    const bookingA = await makeBooking(idA.id, BookingSource.APP);
    const bookingB = await makeBooking(idB.id, BookingSource.WALK_IN);
    await consult.enqueueBooking(TokenSource.APP, session, bookingA); // A001 -> patient A
    await consult.enqueueBooking(TokenSource.WALK_IN, session, bookingB); // W001 -> patient B

    // REAL doctor login via username/password
    const doc = await auth.doctorLogin('dr.rt', 'docpass');
    doctorToken = doc.token;

    // STAFF token (reception desk) scoped to this clinic — walk-in registration
    // is STAFF/ADMIN only.
    staffToken = app
      .get(AuthTokenService)
      .sign({ sub: 'rt-staff', role: 'STAFF', clinicId: CLINIC_ID });
  });

  afterAll(async () => {
    await cleanup();
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await queue.clearSession(session);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({
      where: { mobile: { in: [MOBILE_A, MOBILE_B, '9000000003'] } },
    });
  }

  async function loginPatient(mobile: string): Promise<{ token: string }> {
    await auth.requestPatientOtp(mobile);
    const otp = sms.last!.otp;
    return auth.verifyPatientOtp(mobile, otp);
  }

  async function makeBooking(patientId: string, source: BookingSource): Promise<string> {
    const b = await prisma.booking.create({
      data: {
        patientId,
        doctorId: DOCTOR_ID,
        source,
        sessionDate: new Date(session.sessionDate),
        sessionType: 'MORNING',
        status: BookingStatus.BOOKED,
      },
    });
    return b.id;
  }

  function connect(token: string): Socket {
    return io(url, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    });
  }

  function next(
    socket: Socket,
    events: string[],
    timeoutMs = 3000,
  ): Promise<{ event: string; data: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${events.join('|')}`)),
        timeoutMs,
      );
      for (const ev of events) {
        socket.once(ev, (data: unknown) => {
          clearTimeout(timer);
          resolve({ event: ev, data });
        });
      }
    });
  }

  it('patient (real OTP token) CANNOT join another patient channel; CAN join own', async () => {
    const sock = connect(patientToken);

    // patient A tries to subscribe with patient B's token (W001 -> patient B)
    sock.emit('join', { ...session, token: 'W001' });
    const denied = await next(sock, ['snapshot', 'error']);
    expect(denied.event).toBe('error');
    expect((denied.data as { message: string }).message).toBe('forbidden');

    // own token A001 -> patient A
    sock.emit('join', { ...session, token: 'A001' });
    const ok = await next(sock, ['snapshot', 'error']);
    expect(ok.event).toBe('snapshot');
    const snap = ok.data as { kind: string; eta: { tokenNumber: string } };
    expect(snap.kind).toBe('booking'); // NOT a full queue listing
    expect(snap.eta.tokenNumber).toBe('A001');

    sock.close();
  });

  it('reconnect (real doctor token) triggers an immediate snapshot', async () => {
    const s1 = connect(doctorToken);
    s1.emit('join', session);
    const first = await next(s1, ['snapshot', 'error']);
    expect(first.event).toBe('snapshot');
    expect((first.data as { kind: string }).kind).toBe('session');
    s1.close();

    // reconnect — new socket, no mutation in between
    const s2 = connect(doctorToken);
    s2.emit('join', session);
    const second = await next(s2, ['snapshot', 'error']);
    expect(second.event).toBe('snapshot');
    const snap = second.data as { kind: string; queue: Array<{ tokenNumber: string }> };
    expect(snap.queue.map((q) => q.tokenNumber)).toEqual(['A001', 'W001']);
    s2.close();
  });

  it('connection without a valid token is rejected', async () => {
    const sock = connect('garbage.token');
    const res = await next(sock, ['error', 'disconnect']);
    expect(['error', 'disconnect']).toContain(res.event);
    sock.close();
  });

  // RBAC at the REST layer: /queue/list requires DOCTOR/STAFF/ADMIN
  it('RBAC: no token -> 401, patient -> 403, doctor -> 200', async () => {
    const path = `/queue/list?doctorId=${DOCTOR_ID}&sessionDate=${session.sessionDate}&sessionType=MORNING`;

    const noAuth = await fetch(`${url}${path}`);
    expect(noAuth.status).toBe(401);

    const asPatient = await fetch(`${url}${path}`, {
      headers: { authorization: `Bearer ${patientToken}` },
    });
    expect(asPatient.status).toBe(403);

    const asDoctor = await fetch(`${url}${path}`, {
      headers: { authorization: `Bearer ${doctorToken}` },
    });
    expect(asDoctor.status).toBe(200);
    const body = (await asDoctor.json()) as Array<{ tokenNumber: string }>;
    expect(body.map((q) => q.tokenNumber)).toEqual(['A001', 'W001']);
  });

  // Walk-in registration over REST must broadcast to the session room so new
  // tokens appear in the live queue without a refresh (feature 3 / Reception
  // Dashboard). Registration goes through the orchestrated POST /reception/walkins
  // (STAFF/ADMIN), which creates a real Booking then enqueues + broadcasts.
  it('POST /reception/walkins pushes a live queue:update to joined staff', async () => {
    const sock = connect(doctorToken);
    sock.emit('join', session);
    const snap = await next(sock, ['snapshot', 'error']);
    expect(snap.event).toBe('snapshot');

    // register a walk-in via REST while connected
    const updatePromise = next(sock, ['queue:update'], 4000);
    const res = await fetch(`${url}/reception/walkins`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${staffToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...session,
        mobile: '9000000003',
        name: 'RT Walkin',
      }),
    });
    expect(res.status).toBe(201);

    const pushed = await updatePromise;
    const data = pushed.data as {
      session: SessionKey;
      queue: Array<{ tokenNumber: string }>;
    };
    expect(data.session.doctorId).toBe(DOCTOR_ID);
    // the new walk-in (W002) is now present in the broadcast queue
    expect(data.queue.map((q) => q.tokenNumber)).toContain('W002');
    sock.close();
  });
});
