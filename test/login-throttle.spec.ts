import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { StaffRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { RedisService } from '../src/common/redis/redis.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { PasswordService } from '../src/auth/password.service';

/**
 * P0-7 — brute-force protection on privileged logins.
 *
 * Runs against the real app, real Redis and real Postgres so the test proves
 * the wiring (controller -> @Ip -> service -> Redis), not just the algorithm.
 *
 * The properties being locked in:
 *   1. normal login still works
 *   2. repeated failures eventually 429 instead of 401
 *   3. the cooldown is temporary and self-expiring, never a permanent lock
 *   4. a successful login clears that account's counter
 *   5. an attacker rotating usernames is still caught by the per-IP counter
 *   6. one account's cooldown does not lock a different account
 *   7. authenticated routes are unaffected
 *   8. responses never reveal whether an account exists
 */
describe('Login brute-force throttle', () => {
  let app: INestApplication;
  let redis: RedisService;
  let prisma: PrismaService;

  let base: string;

  // This suite creates and owns its OWN staff account rather than borrowing a
  // seeded one. Two reasons: the seed's passwords are randomly generated per
  // run now, so no test can know them; and a test that needs a real password
  // should not depend on a shared fixture whose credential lives in a file.
  // Both values are generated per run and exist only in this process.
  const STAFF_USER = `throttle-test-${randomUUID().slice(0, 8)}`;
  const STAFF_PASS = randomBytes(18).toString('base64url');
  let staffId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    redis = app.get(RedisService);
    prisma = app.get(PrismaService);

    await app.listen(0);
    base = await app.getUrl();

    // Attach the fixture to an existing clinic so tenant scope is valid.
    const clinic = await prisma.clinic.findFirstOrThrow({ select: { id: true, hospitalId: true } });
    const created = await prisma.staff.create({
      data: {
        username: STAFF_USER,
        name: 'Throttle Test Desk',
        role: StaffRole.RECEPTIONIST,
        clinicId: clinic.id,
        hospitalId: clinic.hospitalId,
        loginCredentials: await app.get(PasswordService).hash(STAFF_PASS),
      },
      select: { id: true },
    });
    staffId = created.id;
  });

  afterAll(async () => {
    // Clear counters BEFORE closing the app — app.close() disconnects Redis, so
    // any cleanup after it fails with "Connection is closed".
    const keys = await redis.redis.keys('pfos:login:fail:*');
    if (keys.length > 0) await redis.redis.del(...keys);
    if (staffId) await prisma.staff.delete({ where: { id: staffId } }).catch(() => undefined);
    await app.close();
  });

  /** Clear every throttle counter so each test starts from a known state. */
  beforeEach(async () => {
    const keys = await redis.redis.keys('pfos:login:fail:*');
    if (keys.length > 0) await redis.redis.del(...keys);
  });

  const login = async (
    username: string,
    password: string,
    path = '/auth/staff/login',
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : {} };
  };

  it('allows a normal successful login', async () => {
    const res = await login(STAFF_USER, STAFF_PASS);
    expect(res.status).toBe(201);
    expect(res.body.token).toBeDefined();
  });

  it('rejects a wrong password with 401, not 429, while under the limit', async () => {
    const res = await login(STAFF_USER, 'wrong-password');
    expect(res.status).toBe(401);
  });

  it('switches from 401 to 429 once the per-account limit is reached', async () => {
    const max = 10; // LOGIN_MAX_ATTEMPTS default
    const statuses: number[] = [];
    for (let i = 0; i < max + 2; i++) {
      statuses.push((await login(STAFF_USER, `wrong-${i}`)).status);
    }
    expect(statuses.slice(0, max)).toEqual(Array(max).fill(401));
    expect(statuses[max]).toBe(429);
    expect(statuses[max + 1]).toBe(429);
  });

  it('blocks the CORRECT password too once throttled — the limit is not bypassable', async () => {
    for (let i = 0; i < 10; i++) await login(STAFF_USER, `wrong-${i}`);
    const res = await login(STAFF_USER, STAFF_PASS);
    expect(res.status).toBe(429);
  });

  it('applies a TEMPORARY cooldown with a retry hint, never a permanent lock', async () => {
    for (let i = 0; i < 10; i++) await login(STAFF_USER, `wrong-${i}`);
    const res = await login(STAFF_USER, STAFF_PASS);

    expect(res.status).toBe(429);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);

    // The counter must carry a TTL — an entry with no expiry would be a
    // permanent lockout requiring operator intervention.
    const ttl = await redis.redis.ttl(`pfos:login:fail:staff:${STAFF_USER}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(900);
  });

  it('does not extend the cooldown window on further attempts (no indefinite lockout)', async () => {
    for (let i = 0; i < 10; i++) await login(STAFF_USER, `wrong-${i}`);
    const key = `pfos:login:fail:staff:${STAFF_USER}`;
    const firstTtl = await redis.redis.ttl(key);

    // An attacker keeps hammering; the window must not be pushed out.
    for (let i = 0; i < 5; i++) await login(STAFF_USER, `still-wrong-${i}`);
    const laterTtl = await redis.redis.ttl(key);

    expect(laterTtl).toBeLessThanOrEqual(firstTtl);
  });

  it('allows login again after the cooldown expires', async () => {
    for (let i = 0; i < 10; i++) await login(STAFF_USER, `wrong-${i}`);
    expect((await login(STAFF_USER, STAFF_PASS)).status).toBe(429);

    // Simulate the window elapsing rather than sleeping 15 minutes.
    await redis.redis.del(`pfos:login:fail:staff:${STAFF_USER}`);

    const res = await login(STAFF_USER, STAFF_PASS);
    expect(res.status).toBe(201);
  });

  it('clears the account counter on a successful login', async () => {
    for (let i = 0; i < 3; i++) await login(STAFF_USER, `wrong-${i}`);
    expect(await redis.redis.get(`pfos:login:fail:staff:${STAFF_USER}`)).toBe('3');

    await login(STAFF_USER, STAFF_PASS);
    expect(await redis.redis.get(`pfos:login:fail:staff:${STAFF_USER}`)).toBeNull();
  });

  it('throttling one account does not lock a DIFFERENT account', async () => {
    for (let i = 0; i < 10; i++) await login('some-other-user', `wrong-${i}`);
    expect((await login('some-other-user', 'x')).status).toBe(429);

    // The real account is untouched (its own counter is separate) — the per-IP
    // budget is higher than the per-account one precisely so this holds.
    const res = await login(STAFF_USER, STAFF_PASS);
    expect(res.status).toBe(201);
  });

  it('catches an attacker rotating usernames via the per-IP counter', async () => {
    // Stay under the per-account limit on every name, but exceed the IP budget.
    for (let i = 0; i < 31; i++) {
      await login(`rotating-user-${i}`, 'wrong');
    }
    const res = await login('rotating-user-999', 'wrong');
    expect(res.status).toBe(429);
  });

  it('counts unknown usernames identically, leaking no account existence', async () => {
    const unknown = await login('definitely-not-a-real-account', 'x');
    const known = await login(STAFF_USER, 'wrong-password');

    expect(unknown.status).toBe(known.status);
    expect(unknown.body.message).toEqual(known.body.message);
  });

  it('protects the doctor login route as well', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await login('drsmith', `wrong-${i}`, '/auth/doctor/login')).status);
    }
    expect(statuses).toContain(429);
  });

  it('leaves authenticated routes unaffected by the login throttle', async () => {
    const { body } = await login(STAFF_USER, STAFF_PASS);
    const token = body.token as string;

    for (let i = 0; i < 15; i++) {
      const res = await fetch(`${base}/clinics?query=`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
    }
  });

  it('never writes a password into the throttle keys', async () => {
    await login(STAFF_USER, 'super-secret-password');
    const keys = await redis.redis.keys('pfos:login:fail:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toContain('super-secret-password');
    }
  });
});
