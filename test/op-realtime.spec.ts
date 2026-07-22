import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AddressInfo } from 'node:net';
import { io, Socket } from 'socket.io-client';
import { EncounterStatus, TokenResetPolicy } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { OpProjectionScheduler } from '../src/realtime/op-projection.scheduler';

/**
 * Task 3 — live projection over the existing Socket.io gateway. Proves the new
 * token-engine surface (op:* rooms/events) pushes read-model snapshots + live
 * deltas to staff (by opSessionId) and patients (by encounterId), driven by the
 * projection tick, WITHOUT touching the legacy realtime contract.
 */
describe('OP realtime — new-engine live updates over sockets', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;
  let tokens: AuthTokenService;
  let scheduler: OpProjectionScheduler;

  const stamp = Date.now();
  const HOSP = `rt2-hosp-${stamp}`;
  const CLINIC = `rt2-clinic-${stamp}`;
  const DOCTOR = `rt2-doc-${stamp}`;
  const SERIES = `rt2-series-${stamp}`;
  const MOBILE = '7400000001';
  const DATE = '2026-08-25';

  let staffTok = '';
  const encounterIds: string[] = [];
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    tokens = app.get(AuthTokenService);
    scheduler = app.get(OpProjectionScheduler);

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'RT2 Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'RT2 Clinic' } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'RT2 Dr', avgConsultMinutes: 10 } });
    await prisma.tokenSeries.create({
      data: {
        id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'Normal',
        prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION,
      },
    });
    staffTok = tokens.sign({ sub: 'rt2-staff', role: 'STAFF', clinicId: CLINIC, hospitalId: HOSP });
  });

  afterAll(async () => {
    for (const s of sockets) s.close();
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const opSessions = await prisma.opSession
      .findMany({ where: { doctorId: DOCTOR }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    for (const s of opSessions) {
      const keys = await redis.redis.keys(`pfos:*${s.id}*`).catch(() => [] as string[]);
      if (keys.length) await redis.redis.del(...keys);
    }
    const seq = await redis.redis.keys(`pfos:tokenseq:${SERIES}:*`).catch(() => [] as string[]);
    if (seq.length) await redis.redis.del(...seq);

    const w = { encounterId: { in: encounterIds } };
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => {});
    await prisma.token.deleteMany({ where: w }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: w }).catch(() => {});
    await prisma.consultation.deleteMany({ where: w }).catch(() => {});
    await prisma.registration.deleteMany({ where: w }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: w }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encounterIds } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: MOBILE } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  function http(path: string, token: string, body?: unknown) {
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }

  function connect(token: string): Promise<Socket> {
    const s = io(url, { transports: ['websocket'], auth: { token }, forceNew: true });
    sockets.push(s);
    return new Promise((resolve, reject) => {
      s.on('connect', () => resolve(s));
      s.on('connect_error', reject);
    });
  }

  function once<T = unknown>(s: Socket, event: string, timeoutMs = 8000): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
      s.once(event, (data: T) => { clearTimeout(timer); resolve(data); });
    });
  }

  /**
   * Drive one projection tick THROUGH the scheduler (not the runner directly),
   * so it serializes with the background @Interval via the scheduler's re-entrancy
   * guard — running two projectors at once would double-insert read models. A tick
   * drains all pending events and, if any applied, re-pushes to watched rooms.
   */
  async function settle(): Promise<void> {
    await scheduler.tick();
  }

  // register -> check-in(+token) -> enqueue; returns the opSessionId + encounterId
  async function seedWaiting(): Promise<{ opSessionId: string; encounterId: string }> {
    const reg = await http('/op/registrations', staffTok, {
      mobile: MOBILE, name: 'RT Patient', doctorId: DOCTOR, serviceDate: DATE, source: 'RECEPTION',
    });
    const enc = (await reg.json()) as { id: string };
    encounterIds.push(enc.id);
    await http(`/op/encounters/${enc.id}/check-in`, staffTok, { method: 'DESK', issueToken: true });
    const enq = await http(`/op/encounters/${enc.id}/enqueue`, staffTok);
    const { opSessionId } = (await enq.json()) as { opSessionId: string };
    return { opSessionId, encounterId: enc.id };
  }

  it('staff joins an op session, gets a snapshot, and a live queue:update on state change', async () => {
    const { opSessionId, encounterId } = await seedWaiting();
    await settle(); // project the enqueue BEFORE anyone joins (read model = WAITING)

    const staff = await connect(staffTok);
    staff.emit('op:join', { kind: 'session', opSessionId });
    const snap = await once<{ kind: string; opSessionId: string; waiting: { encounterId: string }[] }>(staff, 'op:snapshot');
    expect(snap.kind).toBe('session');
    expect(snap.opSessionId).toBe(opSessionId);
    expect(snap.waiting.some((w) => w.encounterId === encounterId)).toBe(true);

    // change state: call the patient -> a pushed update where they are no longer WAITING
    const updateP = once<{ opSessionId: string; waiting: { encounterId: string }[] }>(staff, 'op:queue:update');
    await http(`/op/sessions/${opSessionId}/call-next`, staffTok);
    await settle();
    const update = await updateP;
    expect(update.opSessionId).toBe(opSessionId);
    expect(update.waiting.some((w) => w.encounterId === encounterId)).toBe(false);

    const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } });
    expect(enc.status).toBe(EncounterStatus.CALLED);
  });

  it('patient joins their encounter channel and receives tracking updates', async () => {
    const { opSessionId, encounterId } = await seedWaiting();
    await settle(); // fully drain so no stale WAITING update is queued
    const patientId = (await prisma.encounter.findUniqueOrThrow({ where: { id: encounterId } })).patientId;
    const patientTok = tokens.sign({ sub: patientId, role: 'PATIENT' });

    const patient = await connect(patientTok);
    patient.emit('op:join', { kind: 'encounter', encounterId });
    const snap = await once<{ kind: string; encounterId: string }>(patient, 'op:snapshot');
    expect(snap.kind).toBe('encounter');
    expect(snap.encounterId).toBe(encounterId);

    const trackP = once<{ encounterId: string; tracking: { status: string } | null }>(patient, 'op:tracking:update');
    await http(`/op/sessions/${opSessionId}/call-next`, staffTok);
    await settle();
    const track = await trackP;
    expect(track.encounterId).toBe(encounterId);
    expect(track.tracking?.status).toBe(EncounterStatus.CALLED);
  });

  it('a patient cannot join another patient\'s encounter channel', async () => {
    const { encounterId } = await seedWaiting();
    const strangerTok = tokens.sign({ sub: 'rt2-stranger-patient', role: 'PATIENT' });
    const stranger = await connect(strangerTok);
    stranger.emit('op:join', { kind: 'encounter', encounterId });
    const err = await once<{ message: string }>(stranger, 'error');
    expect(err.message).toBe('forbidden');
  });
});
