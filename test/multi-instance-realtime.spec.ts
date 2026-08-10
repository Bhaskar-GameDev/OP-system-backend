import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import { BookingSource, BookingStatus, StaffRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { QueueEventsService } from '../src/queue-engine/queue-events.service';
import { RedisIoAdapter } from '../src/queue-engine/redis-io.adapter';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';

/**
 * Cross-instance realtime delivery.
 *
 * Socket.io rooms lived in the default in-memory adapter, which is a per-process
 * view. The instant a second backend replica existed, a client connected to
 * instance A would stop receiving events emitted by instance B — and every HTTP
 * call would keep succeeding, so the dashboard would simply go quiet. Partial
 * and silent is the worst shape a failure can take, and nothing in the suite
 * would have caught it, because every other test runs one instance.
 *
 * This suite runs TWO complete backends against the same Postgres and Redis —
 * which is what a scaled-out deployment is — and asserts that an event emitted
 * on one reaches a client connected to the other.
 */
describe('Realtime across two backend instances', () => {
  let appA: INestApplication;
  let appB: INestApplication;
  let adapterA: RedisIoAdapter;
  let adapterB: RedisIoAdapter;
  let urlA: string;
  let urlB: string;
  let prisma: PrismaService;

  const CLINIC_ID = `multi-clinic-${randomUUID().slice(0, 8)}`;
  const DOCTOR_ID = `multi-doctor-${randomUUID().slice(0, 8)}`;
  const session: SessionKey = {
    doctorId: DOCTOR_ID,
    sessionDate: '2030-02-02',
    sessionType: 'MORNING',
  };

  let staffToken = '';
  const sockets: Socket[] = [];

  /** One full backend, wired exactly as main.ts wires production. */
  async function boot(): Promise<{ app: INestApplication; adapter: RedisIoAdapter; url: string }> {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ logger: false });
    const adapter = new RedisIoAdapter(app);
    await adapter.connect();
    app.useWebSocketAdapter(adapter);
    await app.listen(0);
    const url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    return { app, adapter, url };
  }

  beforeAll(async () => {
    ({ app: appA, adapter: adapterA, url: urlA } = await boot());
    ({ app: appB, adapter: adapterB, url: urlB } = await boot());

    prisma = appA.get(PrismaService);
    const hospital = await prisma.hospital.findFirstOrThrow({ select: { id: true } });
    await prisma.clinic.create({
      data: { id: CLINIC_ID, name: 'Multi Instance Clinic', hospitalId: hospital.id },
    });
    await prisma.doctor.create({
      data: { id: DOCTOR_ID, clinicId: CLINIC_ID, name: 'Dr Multi', avgConsultMinutes: 5 },
    });
    await prisma.staff.create({
      data: {
        name: 'Multi Desk',
        role: StaffRole.RECEPTIONIST,
        clinicId: CLINIC_ID,
        hospitalId: hospital.id,
        loginCredentials: 'unused-in-this-suite',
      },
    });

    staffToken = appA.get(AuthTokenService).sign({
      sub: `multi-staff-${randomUUID().slice(0, 8)}`,
      role: 'STAFF',
      clinicId: CLINIC_ID,
      hospitalId: hospital.id,
    });
  });

  afterAll(async () => {
    for (const s of sockets.splice(0)) s.close();
    await appA.get(QueueService).clearSession(session).catch(() => undefined);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.staff.deleteMany({ where: { clinicId: CLINIC_ID } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await Promise.all([adapterA.close(), adapterB.close()]);
    await Promise.all([appA.close(), appB.close()]);
  });

  function connect(url: string, token: string): Socket {
    const socket = io(url, {
      auth: { token },
      transports: ['websocket'],
      forceNew: true,
      reconnection: false,
    });
    sockets.push(socket);
    return socket;
  }

  function once<T>(socket: Socket, event: string, timeoutMs = 5000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`timeout waiting for ${event}`)),
        timeoutMs,
      );
      socket.once(event, (data: T) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
  }

  it('delivers a queue update emitted on instance B to a client joined on instance A', async () => {
    const client = connect(urlA, staffToken);
    client.emit('join', session);
    await once(client, 'snapshot'); // joined on A

    // Nothing else is listening on A: the mutation is driven entirely inside
    // instance B, exactly as it would be if a load balancer had routed the
    // receptionist's REST call there while their socket stayed on A.
    const update = once<{ queue: unknown[] }>(client, 'queue:update');

    const queueB = appB.get(QueueService);
    const eventsB = appB.get(QueueEventsService);
    await queueB.enqueue(TokenSource.WALK_IN, session, 'multi-booking-1');
    eventsB.sessionChanged(session);

    const received = await update;
    expect(Array.isArray(received.queue)).toBe(true);
    expect(received.queue.length).toBeGreaterThan(0);
  });

  it('delivers a patient-channel event across instances without leaking it to others', async () => {
    const bookingId = `multi-booking-${randomUUID().slice(0, 8)}`;

    const patient = await prisma.patient.create({
      data: { mobile: `9${Math.floor(100000000 + Math.random() * 899999999)}`, name: 'Multi' },
    });
    await prisma.booking.create({
      data: {
        id: bookingId,
        patientId: patient.id,
        doctorId: DOCTOR_ID,
        source: BookingSource.WALK_IN,
        sessionDate: new Date(session.sessionDate),
        sessionType: 'MORNING',
        status: BookingStatus.BOOKED,
      },
    });

    const queueA = appA.get(QueueService);
    const entry = await queueA.enqueue(TokenSource.WALK_IN, session, bookingId);

    const patientToken = appA.get(AuthTokenService).sign({ sub: patient.id, role: 'PATIENT' });
    const patientSocket = connect(urlB, patientToken); // patient is on instance B
    patientSocket.emit('join', { ...session, token: entry.tokenNumber });
    await once(patientSocket, 'snapshot');

    // A second staff socket on instance A must NOT receive the patient's
    // private slice — crossing instances must not also cross rooms.
    const staffSocket = connect(urlA, staffToken);
    staffSocket.emit('join', session);
    await once(staffSocket, 'snapshot');
    let staffSawPrivate = false;
    staffSocket.on('eta:update', () => {
      staffSawPrivate = true;
    });

    const own = once<{ booking: string }>(patientSocket, 'eta:update');
    appA.get(QueueEventsService).sessionChanged(session);

    const received = await own;
    expect(received.booking).toBe(bookingId);
    expect(staffSawPrivate).toBe(false);

    await prisma.booking.deleteMany({ where: { id: bookingId } });
    await prisma.patient.deleteMany({ where: { id: patient.id } });
  });
});
