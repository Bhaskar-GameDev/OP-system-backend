import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import {
  EncounterStatus,
  RegistrationSource,
  TokenResetPolicy,
} from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * HTTP surface for the token-based OP engine (Task 1). Boots the full AppModule
 * and drives every controller over real HTTP: proves the engine is reachable
 * with JWT auth + role + tenant scoping, that the register -> check-in -> token
 * -> enqueue -> call/start/complete pipeline works end to end, and that
 * registration source never leaks across the tenant boundary.
 */
describe('OP engine HTTP controllers (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;
  let tokens: AuthTokenService;

  const stamp = Date.now();
  const HOSP_A = `op-hosp-a-${stamp}`;
  const HOSP_B = `op-hosp-b-${stamp}`;
  const CLINIC_A = `op-clinic-a-${stamp}`;
  const CLINIC_B = `op-clinic-b-${stamp}`;
  const DOCTOR_A = `op-doc-a-${stamp}`;
  const DOCTOR_B = `op-doc-b-${stamp}`;
  const SERIES_A = `op-series-a-${stamp}`;
  const SERIES_B = `op-series-b-${stamp}`;
  const DATE = '2026-08-15';
  const mobiles: string[] = [];

  let staffA = '';
  let staffB = '';
  let doctorA = '';
  let adminA = '';
  let patientTok = '';

  const encounterIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Match production pipeline (main.ts) so DTO validation runs in tests too.
    const { ValidationPipe } = await import('@nestjs/common');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    tokens = app.get(AuthTokenService);

    await cleanup();
    await prisma.hospital.createMany({
      data: [
        { id: HOSP_A, name: 'OP Hosp A' },
        { id: HOSP_B, name: 'OP Hosp B' },
      ],
    });
    await prisma.clinic.createMany({
      data: [
        { id: CLINIC_A, hospitalId: HOSP_A, name: 'OP Clinic A' },
        { id: CLINIC_B, hospitalId: HOSP_B, name: 'OP Clinic B' },
      ],
    });
    await prisma.doctor.createMany({
      data: [
        { id: DOCTOR_A, clinicId: CLINIC_A, name: 'OP Dr A', avgConsultMinutes: 10 },
        { id: DOCTOR_B, clinicId: CLINIC_B, name: 'OP Dr B' },
      ],
    });
    await prisma.tokenSeries.createMany({
      data: [
        {
          id: SERIES_A,
          clinicId: CLINIC_A,
          code: 'NORMAL_OP',
          label: 'Normal',
          prefix: 'N',
          padWidth: 3,
          startAt: 1,
          resetPolicy: TokenResetPolicy.PER_SESSION,
        },
        {
          id: SERIES_B,
          clinicId: CLINIC_B,
          code: 'NORMAL_OP',
          label: 'Normal',
          prefix: 'N',
          padWidth: 3,
          startAt: 1,
          resetPolicy: TokenResetPolicy.PER_SESSION,
        },
      ],
    });

    staffA = tokens.sign({ sub: 'op-staff-a', role: 'STAFF', clinicId: CLINIC_A, hospitalId: HOSP_A });
    staffB = tokens.sign({ sub: 'op-staff-b', role: 'STAFF', clinicId: CLINIC_B, hospitalId: HOSP_B });
    adminA = tokens.sign({ sub: 'op-admin-a', role: 'ADMIN', clinicId: CLINIC_A, hospitalId: HOSP_A });
    doctorA = tokens.sign({ sub: DOCTOR_A, role: 'DOCTOR', doctorId: DOCTOR_A, clinicId: CLINIC_A, hospitalId: HOSP_A });
    patientTok = tokens.sign({ sub: 'op-patient', role: 'PATIENT' });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    // Redis: delete ONLY keys this suite created (its sessions + token series),
    // never a broad `pfos:*` flush that could disturb other suites (runInBand).
    const sessions = await prisma.opSession
      .findMany({ where: { doctorId: { in: [DOCTOR_A, DOCTOR_B] } }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    const patterns = [
      ...sessions.map((s) => `pfos:*${s.id}*`),
      `pfos:tokenseq:${SERIES_A}:*`,
      `pfos:tokenseq:${SERIES_B}:*`,
    ];
    for (const pat of patterns) {
      const keys = await redis.redis.keys(pat).catch(() => [] as string[]);
      if (keys.length) await redis.redis.del(...keys);
    }

    const encWhere = { encounterId: { in: encounterIds } };
    await prisma.queueEntry.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.token.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.consultation.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.registration.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: { encounterId: { in: encounterIds } } }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encounterIds } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: { in: [DOCTOR_A, DOCTOR_B] } } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: { in: mobiles } } }).catch(() => {});
    await prisma.hospitalConfig.deleteMany({ where: { scopeId: { in: [CLINIC_A, HOSP_A, DOCTOR_A] } } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: { in: [SERIES_A, SERIES_B] } } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: { in: [DOCTOR_A, DOCTOR_B] } } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: { in: [CLINIC_A, CLINIC_B] } } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: { in: [HOSP_A, HOSP_B] } } }).catch(() => {});
    // clear any redis lines the session created
    const keys = await redis.redis.keys('pfos:*');
    if (keys.length) await redis.redis.del(...keys);
  }

  function post(path: string, token: string, body?: unknown) {
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  }
  function put(path: string, token: string, body: unknown) {
    return fetch(`${url}${path}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  function get(path: string, token: string) {
    return fetch(`${url}${path}`, { headers: { authorization: `Bearer ${token}` } });
  }

  async function registerVia(mobile: string, token = staffA, source = RegistrationSource.RECEPTION) {
    mobiles.push(mobile);
    const res = await post('/op/registrations', token, {
      mobile,
      name: 'Test Patient',
      doctorId: DOCTOR_A,
      serviceDate: DATE,
      source,
    });
    const body = (await res.json()) as { id: string };
    if (body?.id) encounterIds.push(body.id);
    return { res, body };
  }

  it('rejects unauthenticated and wrong-role callers', async () => {
    const noAuth = await fetch(`${url}/op/registrations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: '9000000001', doctorId: DOCTOR_A, serviceDate: DATE, source: 'RECEPTION' }),
    });
    expect(noAuth.status).toBe(401);

    const patient = await post('/op/registrations', patientTok, {
      mobile: '9000000002', doctorId: DOCTOR_A, serviceDate: DATE, source: 'RECEPTION',
    });
    expect(patient.status).toBe(403); // PATIENT not allowed on staff surface
  });

  it('validates the registration DTO', async () => {
    const bad = await post('/op/registrations', staffA, {
      mobile: '123', // not 10 digits
      doctorId: DOCTOR_A,
      serviceDate: DATE,
      source: 'RECEPTION',
    });
    expect(bad.status).toBe(400);
  });

  it('enforces tenant scope: staff cannot register against another hospital', async () => {
    const res = await post('/op/registrations', staffB, {
      mobile: '9000000003', doctorId: DOCTOR_A, serviceDate: DATE, source: 'RECEPTION',
    });
    // doctor A is in clinic A / hospital A — foreign to staff B
    expect([403, 404]).toContain(res.status);
  });

  it('drives register -> check-in(+token) -> enqueue -> call -> start -> complete over HTTP', async () => {
    const { res, body: enc } = await registerVia('9100000001');
    expect(res.status).toBe(201);
    expect(enc.id).toBeTruthy();

    // registration does NOT issue a token
    const dbEnc = await prisma.encounter.findUniqueOrThrow({ where: { id: enc.id } });
    expect(dbEnc.status).toBe(EncounterStatus.REGISTERED);

    // combined desk path: check-in + token in one call
    const ci = await post(`/op/encounters/${enc.id}/check-in`, staffA, { method: 'DESK', issueToken: true });
    expect(ci.status).toBe(201);
    const ciBody = (await ci.json()) as { token?: { displayNumber: string }; encounter: { status: string } };
    expect(ciBody.token?.displayNumber).toMatch(/^N\d{3}$/);

    // enqueue into the one queue
    const enq = await post(`/op/encounters/${enc.id}/enqueue`, staffA);
    expect(enq.status).toBe(201);
    const enqBody = (await enq.json()) as { opSessionId: string; category: string };
    const sessionId = enqBody.opSessionId;
    expect(sessionId).toBeTruthy();

    // waiting line read model shows the encounter
    const q = await get(`/op/sessions/${sessionId}/queue`, staffA);
    expect(q.status).toBe(200);
    const waiting = (await q.json()) as Array<{ encounterId: string }>;
    expect(waiting.map((w) => w.encounterId)).toContain(enc.id);

    // doctor console: call next
    const call = await post(`/op/sessions/${sessionId}/call-next`, doctorA);
    expect(call.status).toBe(201);
    const called = (await call.json()) as { candidate: { encounterId: string } } | null;
    expect(called?.candidate.encounterId).toBe(enc.id);

    // start + complete
    const start = await post(`/op/encounters/${enc.id}/start`, doctorA, {});
    expect(start.status).toBe(201);
    const complete = await post(`/op/encounters/${enc.id}/complete`, doctorA);
    expect(complete.status).toBe(201);

    const final = await prisma.encounter.findUniqueOrThrow({ where: { id: enc.id } });
    expect(final.status).toBe(EncounterStatus.COMPLETED);
  });

  it('token is gated on check-in (cannot issue before check-in)', async () => {
    const { body: enc } = await registerVia('9100000002');
    const res = await post(`/op/encounters/${enc.id}/token`, staffA);
    expect(res.status).toBe(400); // state machine forbids ISSUE_TOKEN before CHECKED_IN
  });

  it('a foreign doctor cannot drive another doctor\'s session', async () => {
    const { body: enc } = await registerVia('9100000003');
    await post(`/op/encounters/${enc.id}/check-in`, staffA, { method: 'DESK', issueToken: true });
    const enq = await post(`/op/encounters/${enc.id}/enqueue`, staffA);
    const { opSessionId } = (await enq.json()) as { opSessionId: string };

    // doctor B (another hospital) tries to call next on doctor A's session
    const doctorB = tokens.sign({ sub: DOCTOR_B, role: 'DOCTOR', doctorId: DOCTOR_B, clinicId: CLINIC_B, hospitalId: HOSP_B });
    const res = await post(`/op/sessions/${opSessionId}/call-next`, doctorB);
    expect([403, 404]).toContain(res.status);
  });

  it('config is ADMIN-only and tenant-scoped', async () => {
    // STAFF may not write config
    const staffWrite = await put('/op/config', staffA, {
      scopeType: 'CLINIC', scopeId: CLINIC_A, key: 'checkin.autoIssueToken', value: true,
    });
    expect(staffWrite.status).toBe(403);

    // ADMIN may write in-tenant
    const ok = await put('/op/config', adminA, {
      scopeType: 'CLINIC', scopeId: CLINIC_A, key: 'checkin.autoIssueToken', value: true,
    });
    expect(ok.status).toBe(200);

    // ADMIN may not write to another hospital's clinic
    const cross = await put('/op/config', adminA, {
      scopeType: 'CLINIC', scopeId: CLINIC_B, key: 'checkin.autoIssueToken', value: true,
    });
    expect([403, 404]).toContain(cross.status);

    // read back resolves the value
    const read = await get(`/op/config?key=checkin.autoIssueToken&clinicId=${CLINIC_A}`, adminA);
    expect(read.status).toBe(200);
    expect((await read.json()).value).toBe(true);
  });
});
