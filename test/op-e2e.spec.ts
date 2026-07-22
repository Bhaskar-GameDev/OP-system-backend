import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { EncounterStatus, TokenResetPolicy } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { OpProjectionScheduler } from '../src/realtime/op-projection.scheduler';

/**
 * Task 6 — end-to-end validation checklist over authenticated HTTP (full stack).
 * Walks all THREE registration sources through the ONE pipeline, proves that
 * registration source is analytics-only and NEVER affects queue order, and proves
 * multi-tenant isolation across a second hospital/clinic.
 */
describe('OP engine E2E — three sources, one queue, multi-tenant isolation', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;
  let tokens: AuthTokenService;
  let scheduler: OpProjectionScheduler;

  const stamp = Date.now();
  const HOSP_A = `e2e-hospA-${stamp}`;
  const HOSP_B = `e2e-hospB-${stamp}`;
  const CLINIC_A = `e2e-clinicA-${stamp}`;
  const CLINIC_B = `e2e-clinicB-${stamp}`;
  const DOCTOR_A = `e2e-docA-${stamp}`;
  const DOCTOR_B = `e2e-docB-${stamp}`;
  const SERIES_A = `e2e-serA-${stamp}`;
  const SERIES_B = `e2e-serB-${stamp}`;
  const DATE = '2026-09-20';
  const mobiles: string[] = [];
  const encounterIds: string[] = [];

  let staffA = '';
  let staffB = '';
  let doctorA = '';
  let doctorB = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    tokens = app.get(AuthTokenService);
    scheduler = app.get(OpProjectionScheduler);

    await cleanup();
    await prisma.hospital.createMany({ data: [{ id: HOSP_A, name: 'E2E A' }, { id: HOSP_B, name: 'E2E B' }] });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A, hospitalId: HOSP_A, name: 'E2E CA' },
        { id: CLINIC_B, hospitalId: HOSP_B, name: 'E2E CB' },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        { id: DOCTOR_A, clinicId: CLINIC_A, name: 'E2E DrA', avgConsultMinutes: 10 },
        { id: DOCTOR_B, clinicId: CLINIC_B, name: 'E2E DrB', avgConsultMinutes: 10 },
      ],
    });
    await prisma.tokenSeries.createMany({
      data: [
        { id: SERIES_A, clinicId: CLINIC_A, code: 'NORMAL_OP', label: 'Normal', prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION },
        { id: SERIES_B, clinicId: CLINIC_B, code: 'NORMAL_OP', label: 'Normal', prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION },
      ],
    });
    staffA = tokens.sign({ sub: 'e2e-staffA', role: 'STAFF', clinicId: CLINIC_A, hospitalId: HOSP_A });
    staffB = tokens.sign({ sub: 'e2e-staffB', role: 'STAFF', clinicId: CLINIC_B, hospitalId: HOSP_B });
    doctorA = tokens.sign({ sub: DOCTOR_A, role: 'DOCTOR', doctorId: DOCTOR_A, clinicId: CLINIC_A, hospitalId: HOSP_A });
    doctorB = tokens.sign({ sub: DOCTOR_B, role: 'DOCTOR', doctorId: DOCTOR_B, clinicId: CLINIC_B, hospitalId: HOSP_B });
  });

  afterAll(async () => {
    for (const s of await prisma.opSession.findMany({ where: { doctorId: { in: [DOCTOR_A, DOCTOR_B] } }, select: { id: true } }).catch(() => [])) {
      const keys = await redis.redis.keys(`pfos:*${s.id}*`).catch(() => [] as string[]);
      if (keys.length) await redis.redis.del(...keys);
    }
    for (const ser of [SERIES_A, SERIES_B]) {
      const k = await redis.redis.keys(`pfos:tokenseq:${ser}:*`).catch(() => [] as string[]);
      if (k.length) await redis.redis.del(...k);
    }
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    const w = { encounterId: { in: encounterIds } };
    await prisma.queueEntry.deleteMany({ where: w }).catch(() => {});
    await prisma.token.deleteMany({ where: w }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: w }).catch(() => {});
    await prisma.consultation.deleteMany({ where: w }).catch(() => {});
    await prisma.registration.deleteMany({ where: w }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: w }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encounterIds } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: { in: [DOCTOR_A, DOCTOR_B] } } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: { in: mobiles } } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: { in: [SERIES_A, SERIES_B] } } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: { in: [DOCTOR_A, DOCTOR_B] } } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: { in: [HOSP_A, HOSP_B] } } }).catch(() => {});
  }

  function post(path: string, token: string, body?: unknown) {
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }
  function get(path: string, token: string) {
    return fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  async function register(source: string, mobile: string, doctorId: string, staff: string): Promise<string> {
    mobiles.push(mobile);
    const res = await post('/op/registrations', staff, { mobile, name: `P-${source}`, doctorId, serviceDate: DATE, source });
    expect(res.status).toBe(201);
    const enc = (await res.json()) as { id: string };
    encounterIds.push(enc.id);
    return enc.id;
  }

  /** check-in (+token) then enqueue; returns the opSessionId. */
  async function flowIntoQueue(encId: string, staff: string): Promise<string> {
    const ci = await post(`/op/encounters/${encId}/check-in`, staff, { method: 'DESK', issueToken: true });
    expect(ci.status).toBe(201);
    const enq = await post(`/op/encounters/${encId}/enqueue`, staff);
    expect(enq.status).toBe(201);
    return ((await enq.json()) as { opSessionId: string }).opSessionId;
  }

  async function waitingOrder(opSessionId: string, staff: string): Promise<string[]> {
    const res = await get(`/op/sessions/${opSessionId}/queue`, staff);
    expect(res.status).toBe(200);
    return ((await res.json()) as { encounterId: string }[]).map((w) => w.encounterId);
  }

  it('all three sources register, and REGISTRATION SOURCE NEVER AFFECTS QUEUE ORDER', async () => {
    // Registration order: APP, VOICE_AGENT, RECEPTION
    const appEnc = await register('APP', '7800000001', DOCTOR_A, staffA);
    const voiceEnc = await register('VOICE_AGENT', '7800000002', DOCTOR_A, staffA);
    const recEnc = await register('RECEPTION', '7800000003', DOCTOR_A, staffA);

    // registration issues NO token
    expect((await prisma.encounter.findUniqueOrThrow({ where: { id: appEnc } })).status).toBe(EncounterStatus.REGISTERED);

    // Enqueue in a DIFFERENT order than registration or source: VOICE, RECEPTION, APP.
    const s1 = await flowIntoQueue(voiceEnc, staffA);
    const s2 = await flowIntoQueue(recEnc, staffA);
    const s3 = await flowIntoQueue(appEnc, staffA);
    expect(s1).toBe(s2);
    expect(s2).toBe(s3); // one shared session/queue for the doctor+day

    // The queue follows ARRIVAL (enqueue) order, independent of source.
    expect(await waitingOrder(s1, staffA)).toEqual([voiceEnc, recEnc, appEnc]);

    // Source IS recorded (analytics), just never used for ordering.
    const regs = await prisma.registration.findMany({ where: { encounterId: { in: [appEnc, voiceEnc, recEnc] } } });
    expect(new Set(regs.map((r) => r.source))).toEqual(new Set(['APP', 'VOICE_AGENT', 'RECEPTION']));
  });

  it('enforces multi-tenant isolation across a second hospital', async () => {
    // build hospital A's queue is already done above; capture its session
    const sessionA = (await prisma.opSession.findFirstOrThrow({ where: { doctorId: DOCTOR_A }, select: { id: true } })).id;

    // Hospital B registers + enqueues its own patient
    const bEnc = await register('APP', '7800000009', DOCTOR_B, staffB);
    const sessionB = await flowIntoQueue(bEnc, staffB);
    expect(sessionB).not.toBe(sessionA);

    // queues are independent: A still has its 3, B has its 1
    expect((await waitingOrder(sessionA, staffA)).length).toBe(3);
    expect((await waitingOrder(sessionB, staffB)).length).toBe(1);

    // staff B cannot register against hospital A's doctor
    const crossReg = await post('/op/registrations', staffB, { mobile: '7800000010', doctorId: DOCTOR_A, serviceDate: DATE, source: 'RECEPTION' });
    expect([403, 404]).toContain(crossReg.status);

    // staff B cannot read hospital A's session queue
    const crossRead = await get(`/op/sessions/${sessionA}/queue`, staffB);
    expect([403, 404]).toContain(crossRead.status);

    // doctor B cannot call-next on hospital A's session
    const crossCall = await post(`/op/sessions/${sessionA}/call-next`, doctorB);
    expect([403, 404]).toContain(crossCall.status);
  });

  it('token is gated on check-in (registration ≠ token)', async () => {
    const enc = await register('APP', '7800000011', DOCTOR_A, staffA);
    const res = await post(`/op/encounters/${enc}/token`, staffA);
    expect(res.status).toBe(400); // ISSUE_TOKEN illegal before CHECKED_IN
  });

  it('walks the doctor console lifecycle and updates read models', async () => {
    const session = (await prisma.opSession.findFirstOrThrow({ where: { doctorId: DOCTOR_A }, select: { id: true } })).id;
    const before = await waitingOrder(session, staffA);
    const first = before[0]; // the earliest-arrived (voiceEnc)

    const call = await post(`/op/sessions/${session}/call-next`, doctorA);
    expect(call.status).toBe(201);
    expect(((await call.json()) as { candidate: { encounterId: string } }).candidate.encounterId).toBe(first);

    expect((await post(`/op/encounters/${first}/start`, doctorA, {})).status).toBe(201);
    expect((await post(`/op/encounters/${first}/complete`, doctorA)).status).toBe(201);
    expect((await prisma.encounter.findUniqueOrThrow({ where: { id: first } })).status).toBe(EncounterStatus.COMPLETED);

    // drive the projection, then the read models reflect the new reality
    await scheduler.tick();
    const track = await get(`/op/encounters/${first}/tracking`, staffA);
    expect(track.status).toBe(200);
    expect(((await track.json()) as { status: string }).status).toBe(EncounterStatus.COMPLETED);

    const dash = await get(`/op/doctors/${DOCTOR_A}/dashboard`, doctorA);
    expect(dash.status).toBe(200);
    const board = (await dash.json()) as { waiting: { encounterId: string }[] };
    // the completed patient is no longer waiting
    expect(board.waiting.some((w) => w.encounterId === first)).toBe(false);
  });
});
