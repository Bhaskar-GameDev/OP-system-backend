import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { RedisService } from '../src/common/redis/redis.service';

/**
 * POST /setup/hospital — the unauthenticated tenant bootstrap behind the desk
 * app's "Set up hospital" screen. Proves the gate (disabled without a key, 401 on
 * a wrong one), that a provisioned hospital is immediately usable (its admin can
 * log in and the clinic can mint tokens), that input is validated, that clashes
 * are refused, and that nothing is written when any of that fails.
 */
describe('Hospital setup (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;
  let redis: RedisService;

  const KEY = 'test-setup-key-that-is-long-enough-000000';
  const HOSPITAL = 'Setup Spec Hospital';
  const CLINIC = 'Setup Spec Clinic';
  const ADMIN = 'setup-spec-admin';
  const PASSWORD = 'SetupSpecPassw0rd!';

  // The service reads the key through ConfigService on every call, so one stub
  // covers enabled and disabled without rebuilding the app.
  let setupKey = KEY;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    // Mirror main.ts: the route relies on the same pipe being present.
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));

    const config = app.get(ConfigService);
    const realGet = config.get.bind(config);
    jest
      .spyOn(config, 'get')
      .mockImplementation((key: string, ...rest: unknown[]) =>
        key === 'HOSPITAL_SETUP_KEY'
          ? (setupKey as never)
          : (realGet as (k: string, ...r: unknown[]) => unknown)(key, ...rest),
      );

    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);
    redis = app.get(RedisService);
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  beforeEach(async () => {
    setupKey = KEY;
    // The throttle is Redis-backed and shared across tests in this file.
    await redis.redis.del('pfos:login:fail:hospital-setup:setup-key');
  });

  async function cleanup(): Promise<void> {
    const hospitals = await prisma.hospital.findMany({
      where: { name: { in: [HOSPITAL, `${HOSPITAL} Two`] } },
      select: { id: true },
    });
    const ids = hospitals.map((h) => h.id);
    if (ids.length === 0) {
      await prisma.staff.deleteMany({ where: { username: ADMIN } });
      return;
    }
    const clinics = await prisma.clinic.findMany({
      where: { hospitalId: { in: ids } },
      select: { id: true },
    });
    const clinicIds = clinics.map((c) => c.id);
    await prisma.queuePolicy.deleteMany({ where: { clinicId: { in: clinicIds } } });
    await prisma.tokenSeries.deleteMany({ where: { clinicId: { in: clinicIds } } });
    await prisma.staff.deleteMany({ where: { clinicId: { in: clinicIds } } });
    await prisma.staff.deleteMany({ where: { username: ADMIN } });
    await prisma.clinic.deleteMany({ where: { id: { in: clinicIds } } });
    await prisma.hospital.deleteMany({ where: { id: { in: ids } } });
  }

  function setup(body: Record<string, unknown>) {
    return fetch(`${url}/setup/hospital`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** validBody minus one field, for "this is required" assertions. */
  function without(field: string): Record<string, unknown> {
    const copy: Record<string, unknown> = { ...validBody };
    delete copy[field];
    return copy;
  }

  const validBody = {
    setupKey: KEY,
    hospital: HOSPITAL,
    clinic: CLINIC,
    address: '12 MG Road',
    contactNumber: '+918040001234',
    adminUsername: ADMIN,
    adminPassword: PASSWORD,
  };

  /** What the desk app actually sends: no clinic name. */
  const deskBody = {
    setupKey: KEY,
    hospital: HOSPITAL,
    address: '12 MG Road',
    contactNumber: '+918040001234',
    adminUsername: ADMIN,
    adminPassword: PASSWORD,
  };

  it('is invisible (404) when no setup key is configured', async () => {
    setupKey = '';
    const res = await setup(validBody);
    expect(res.status).toBe(404);
    // and wrote nothing
    expect(await prisma.hospital.count({ where: { name: HOSPITAL } })).toBe(0);
  });

  it('reports whether setup is available', async () => {
    const on = await (await fetch(`${url}/setup/status`)).json();
    expect(on).toEqual({ enabled: true });

    setupKey = '   ';
    const off = await (await fetch(`${url}/setup/status`)).json();
    expect(off).toEqual({ enabled: false });
  });

  it('rejects a wrong key with 401 and writes nothing', async () => {
    const res = await setup({ ...validBody, setupKey: 'not-the-key' });
    expect(res.status).toBe(401);
    expect(await prisma.hospital.count({ where: { name: HOSPITAL } })).toBe(0);
    expect(await prisma.staff.count({ where: { username: ADMIN } })).toBe(0);
  });

  it('validates input only after the key passes', async () => {
    // a bad key on an invalid body must still be a 401, never a 400 that would
    // reveal the request shape to someone without the key
    expect((await setup({ setupKey: 'nope' })).status).toBe(401);

    expect((await setup({ setupKey: KEY, hospital: 'x' })).status).toBe(400);
    expect(
      (await setup({ ...validBody, adminUsername: 'Bad Username!' })).status,
    ).toBe(400);
    expect((await setup({ ...validBody, adminPassword: 'short' })).status).toBe(400);
    // a password containing the username is refused
    expect(
      (await setup({ ...validBody, adminPassword: `${ADMIN}-1234567` })).status,
    ).toBe(400);
  });

  it('requires a real address and contact number', async () => {
    expect((await setup(without('address'))).status).toBe(400);
    expect((await setup({ ...validBody, address: '  ' })).status).toBe(400);

    expect((await setup(without('contactNumber'))).status).toBe(400);
    // digits, not decoration — "n/a" or a stray dash is the same as no contact
    expect((await setup({ ...validBody, contactNumber: 'n/a' })).status).toBe(400);
    expect((await setup({ ...validBody, contactNumber: '- -' })).status).toBe(400);

    expect(await prisma.hospital.count({ where: { name: HOSPITAL } })).toBe(0);
  });

  it('the first clinic takes the hospital name when none is given', async () => {
    // exactly what the desk app posts: no clinic, locally-formatted number
    const res = await setup({ ...deskBody, contactNumber: '080 4000 1234' });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { clinicId: string; clinicName: string };
    expect(body.clinicName).toBe(HOSPITAL);

    const clinic = await prisma.clinic.findUnique({
      where: { id: body.clinicId },
      select: { name: true, address: true, contactNumber: true },
    });
    // formatting is preserved as typed, not normalised
    expect(clinic).toEqual({
      name: HOSPITAL,
      address: '12 MG Road',
      contactNumber: '080 4000 1234',
    });
    await cleanup();
  });

  it('provisions a hospital that is immediately usable', async () => {
    const res = await setup(validBody);
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      hospitalId: string;
      clinicId: string;
      adminUsername: string;
    };
    // never returns a session — creating a tenant and signing in stay separate
    expect(body).not.toHaveProperty('token');
    expect(body.adminUsername).toBe(ADMIN);

    // the clinic can mint tokens (the config a clinic is broken without)
    const series = await prisma.tokenSeries.findMany({
      where: { clinicId: body.clinicId },
      select: { code: true, prefix: true, startAt: true },
      orderBy: { code: 'asc' },
    });
    expect(series).toEqual([
      { code: 'NORMAL_OP', prefix: 'N', startAt: 1 },
      { code: 'SPECIAL_OP', prefix: 'S', startAt: 101 },
    ]);
    expect(
      await prisma.queuePolicy.count({
        where: { clinicId: body.clinicId, doctorId: null },
      }),
    ).toBe(1);

    // the admin can actually sign in, scoped to the new hospital
    const login = await fetch(`${url}/auth/staff/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN, password: PASSWORD }),
    });
    expect(login.status).toBe(201);
    const session = (await login.json()) as { token: string; role: string };
    expect(session.role).toBe('ADMIN');
    const claims = tokens.verify(session.token);
    expect(claims.hospitalId).toBe(body.hospitalId);
    expect(claims.clinicId).toBe(body.clinicId);

    // and that token only ever sees its own hospital
    const clinics = await fetch(`${url}/admin/clinics`, {
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(clinics.status).toBe(200);
    const list = (await clinics.json()) as { id: string }[];
    expect(list.map((c) => c.id)).toEqual([body.clinicId]);
  });

  it('refuses a duplicate hospital name or username (409), leaving the original intact', async () => {
    const dupHospital = await setup(validBody);
    expect(dupHospital.status).toBe(409);

    const dupUsername = await setup({ ...validBody, hospital: `${HOSPITAL} Two` });
    expect(dupUsername.status).toBe(409);
    // the 409 must not have created the second hospital on its way out
    expect(await prisma.hospital.count({ where: { name: `${HOSPITAL} Two` } })).toBe(0);
    expect(await prisma.staff.count({ where: { username: ADMIN } })).toBe(1);
  });

  it('throttles setup-key guessing', async () => {
    // LOGIN_MAX_ATTEMPTS defaults to 10 for the per-identifier counter
    for (let i = 0; i < 10; i += 1) {
      await setup({ ...validBody, setupKey: `wrong-${i}` });
    }
    const res = await setup({ ...validBody, setupKey: 'wrong-again' });
    expect(res.status).toBe(429);
  });
});
