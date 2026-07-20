import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { BookingSource, BookingStatus, SessionType } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';

/**
 * Multi-tenant ISOLATION — the cross-hospital boundary, proven end-to-end against
 * real Postgres + Redis + Socket.io. Two hospitals (A, B), one clinic + doctor
 * each. Hospital A's ADMIN must never read or mutate Hospital B's clinic/doctor/
 * session/audit/booking, never see B in an aggregate, and a Hospital A socket
 * must never join — nor receive an event for — a Hospital B queue.
 */
describe('Multi-tenant isolation (real infra)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let queue: QueueService;

  const HOSP_A = 'ti-hosp-a';
  const HOSP_B = 'ti-hosp-b';
  const CLINIC_A = 'ti-clinic-a';
  const CLINIC_B = 'ti-clinic-b';
  const DOC_A = 'ti-doc-a';
  const DOC_B = 'ti-doc-b';
  const PT_A = 'ti-pt-a';
  const PT_B = 'ti-pt-b';

  const DATE = '2026-06-20';
  const sessionA: SessionKey = { doctorId: DOC_A, sessionDate: DATE, sessionType: 'MORNING' };
  const sessionB: SessionKey = { doctorId: DOC_B, sessionDate: DATE, sessionType: 'MORNING' };

  let adminA = '';
  let adminB = '';
  let doctorA = '';
  let staffB = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    queue = app.get(QueueService);
    const tokens = app.get(AuthTokenService);

    await cleanup();

    await prisma.hospital.createMany({
      data: [
        { id: HOSP_A, name: 'Hospital A' },
        { id: HOSP_B, name: 'Hospital B' },
      ],
    });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A, hospitalId: HOSP_A, name: 'A Clinic' },
        { id: CLINIC_B, hospitalId: HOSP_B, name: 'B Clinic' },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        { id: DOC_A, clinicId: CLINIC_A, name: 'Dr A', avgConsultMinutes: 5 },
        { id: DOC_B, clinicId: CLINIC_B, name: 'Dr B', avgConsultMinutes: 5 },
      ],
    });
    await prisma.patient.createMany({
      data: [
        { id: PT_A, name: 'Pat A', mobile: '9300000001' },
        { id: PT_B, name: 'Pat B', mobile: '9300000002' },
      ],
    });

    // One settled (COMPLETED) booking per clinic so reports have something to
    // aggregate — and a leak would show up as a non-zero cross-tenant count.
    const booked = new Date(`${DATE}T09:00:00.000Z`);
    await prisma.booking.create({
      data: {
        id: 'ti-bk-a', patientId: PT_A, doctorId: DOC_A, source: BookingSource.APP,
        tokenNumber: 'A001', sessionDate: new Date(DATE), sessionType: SessionType.MORNING,
        status: BookingStatus.COMPLETED, createdAt: booked,
        consultationStartedAt: new Date(`${DATE}T09:10:00.000Z`),
        consultationEndedAt: new Date(`${DATE}T09:20:00.000Z`),
      },
    });
    await prisma.booking.create({
      data: {
        id: 'ti-bk-b', patientId: PT_B, doctorId: DOC_B, source: BookingSource.APP,
        tokenNumber: 'A001', sessionDate: new Date(DATE), sessionType: SessionType.MORNING,
        status: BookingStatus.COMPLETED, createdAt: booked,
        consultationStartedAt: new Date(`${DATE}T09:10:00.000Z`),
        consultationEndedAt: new Date(`${DATE}T09:20:00.000Z`),
      },
    });

    // Audit rows: one per clinic.
    await prisma.auditLog.createMany({
      data: [
        { actorId: 'ti-staff-a', actorRole: 'STAFF', clinicId: CLINIC_A, action: 'DONE', doctorId: DOC_A, sessionDate: new Date(DATE), sessionType: SessionType.MORNING, token: 'A001' },
        { actorId: 'ti-staff-b', actorRole: 'STAFF', clinicId: CLINIC_B, action: 'DONE', doctorId: DOC_B, sessionDate: new Date(DATE), sessionType: SessionType.MORNING, token: 'A001' },
      ],
    });

    adminA = tokens.sign({ sub: 'ti-admin-a', role: 'ADMIN', clinicId: CLINIC_A, hospitalId: HOSP_A });
    adminB = tokens.sign({ sub: 'ti-admin-b', role: 'ADMIN', clinicId: CLINIC_B, hospitalId: HOSP_B });
    doctorA = tokens.sign({ sub: DOC_A, role: 'DOCTOR', doctorId: DOC_A, clinicId: CLINIC_A, hospitalId: HOSP_A });
    staffB = tokens.sign({ sub: 'ti-staff-b', role: 'STAFF', clinicId: CLINIC_B, hospitalId: HOSP_B });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await queue.clearSession(sessionA).catch(() => undefined);
    await queue.clearSession(sessionB).catch(() => undefined);
    await prisma.auditLog.deleteMany({ where: { clinicId: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.booking.deleteMany({ where: { doctorId: { in: [DOC_A, DOC_B] } } });
    await prisma.bookingHistory.deleteMany({ where: { clinicId: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.doctorSession.deleteMany({ where: { doctorId: { in: [DOC_A, DOC_B] } } });
    await prisma.doctor.deleteMany({ where: { id: { in: [DOC_A, DOC_B] } } });
    await prisma.patient.deleteMany({ where: { id: { in: [PT_A, PT_B] } } });
    await prisma.patient.deleteMany({ where: { mobile: '9300000003' } }); // walk-in

    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } });
    await prisma.hospital.deleteMany({ where: { id: { in: [HOSP_A, HOSP_B] } } });
  }

  const authGet = (path: string, token: string) =>
    fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  const authSend = (path: string, token: string, method: string, body: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  // ── REST isolation ───────────────────────────────────────────────────────

  it('admin clinic list is hospital-scoped; a foreign clinic by id is 404', async () => {
    const list = (await (await authGet('/admin/clinics', adminA)).json()) as { id: string }[];
    expect(list.some((c) => c.id === CLINIC_A)).toBe(true);
    expect(list.some((c) => c.id === CLINIC_B)).toBe(false); // never B

    const foreign = await authGet(`/admin/clinics/${CLINIC_B}`, adminA);
    expect(foreign.status).toBe(404); // exists, but not in A's hospital
  });

  it('admin cannot read/mutate a foreign hospital doctor or its sessions', async () => {
    expect((await authGet(`/admin/doctors/${DOC_B}`, adminA)).status).toBe(403);
    expect((await authSend(`/admin/doctors/${DOC_B}`, adminA, 'PATCH', { name: 'Hijacked' })).status).toBe(403);
    expect(
      (await authSend(`/admin/doctors/${DOC_B}/sessions`, adminA, 'POST', {
        sessionType: 'MORNING', startTime: '09:00', maxTokens: 5, daysOfWeek: [1],
      })).status,
    ).toBe(403);

    const docB = await prisma.doctor.findUniqueOrThrow({ where: { id: DOC_B } });
    expect(docB.name).toBe('Dr B'); // untouched
    expect(await prisma.doctorSession.count({ where: { doctorId: DOC_B } })).toBe(0);
  });

  it('audit log is hospital-scoped: A never sees B rows, and vice versa', async () => {
    const a = (await (await authGet('/audit-log', adminA)).json()) as { entries: { doctorId: string }[] };
    expect(a.entries.length).toBeGreaterThan(0);
    expect(a.entries.every((e) => e.doctorId === DOC_A)).toBe(true);
    expect(a.entries.some((e) => e.doctorId === DOC_B)).toBe(false);

    const b = (await (await authGet('/audit-log', adminB)).json()) as { entries: { doctorId: string }[] };
    expect(b.entries.every((e) => e.doctorId === DOC_B)).toBe(true);
  });

  it('reports aggregate excludes the other hospital entirely', async () => {
    const a = (await (await authGet('/admin/reports/summary', adminA)).json()) as {
      totals: { total: number }; doctors: { doctorId: string }[];
    };
    expect(a.totals.total).toBe(1); // only A's booking
    expect(a.doctors.every((d) => d.doctorId === DOC_A)).toBe(true);
    expect(a.doctors.some((d) => d.doctorId === DOC_B)).toBe(false);

    const b = (await (await authGet('/admin/reports/summary', adminB)).json()) as {
      totals: { total: number }; doctors: { doctorId: string }[];
    };
    expect(b.totals.total).toBe(1); // only B's booking — no cross-contamination
    expect(b.doctors.every((d) => d.doctorId === DOC_B)).toBe(true);
  });

  // ── Socket.io isolation ──────────────────────────────────────────────────

  function connect(token: string): Socket {
    return io(url, { auth: { token }, transports: ['websocket'], reconnection: false, forceNew: true });
  }
  function next(socket: Socket, events: string[], timeoutMs = 3000): Promise<{ event: string; data: unknown }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${events.join('|')}`)), timeoutMs);
      for (const ev of events) socket.once(ev, (data: unknown) => { clearTimeout(timer); resolve({ event: ev, data }); });
    });
  }
  /** Resolves true if NO event arrives within the window (the no-leak assertion). */
  function silentFor(socket: Socket, event: string, windowMs = 1500): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(true), windowMs);
      socket.once(event, () => { clearTimeout(timer); resolve(false); });
    });
  }

  it('a Hospital A socket cannot JOIN a Hospital B queue room', async () => {
    // doctor A -> B's session
    const docSock = connect(doctorA);
    docSock.emit('join', sessionB);
    const r1 = await next(docSock, ['snapshot', 'error']);
    expect(r1.event).toBe('error');
    expect((r1.data as { message: string }).message).toBe('forbidden');
    docSock.close();

    // admin A -> B's session (admin is hospital-wide, but only within OWN hospital)
    const admSock = connect(adminA);
    admSock.emit('join', sessionB);
    const r2 = await next(admSock, ['snapshot', 'error']);
    expect(r2.event).toBe('error');
    expect((r2.data as { message: string }).message).toBe('forbidden');

    // sanity: admin A CAN join A's own session
    admSock.emit('join', sessionA);
    const r3 = await next(admSock, ['snapshot', 'error']);
    expect(r3.event).toBe('snapshot');
    admSock.close();
  });

  it('a Hospital B queue mutation never reaches a Hospital A socket', async () => {
    const sockA = connect(doctorA); // joined to A's room
    sockA.emit('join', sessionA);
    expect((await next(sockA, ['snapshot', 'error'])).event).toBe('snapshot');

    const sockB = connect(staffB); // joined to B's room
    sockB.emit('join', sessionB);
    expect((await next(sockB, ['snapshot', 'error'])).event).toBe('snapshot');

    // A must stay silent while B's room receives the mutation broadcast.
    const aSilent = silentFor(sockA, 'queue:update', 2000);
    const bGotUpdate = next(sockB, ['queue:update'], 4000);

    const reg = await authSend('/reception/walkins', staffB, 'POST', {
      ...sessionB, mobile: '9300000003', name: 'B Walkin',
    });
    expect(reg.status).toBe(201);

    expect((await bGotUpdate).event).toBe('queue:update'); // B did receive it
    expect(await aSilent).toBe(true); // A received NOTHING

    sockA.close();
    sockB.close();
  });
});
