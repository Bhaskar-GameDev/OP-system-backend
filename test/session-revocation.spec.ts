import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { randomBytes, randomUUID } from 'node:crypto';
import { StaffRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { PasswordService } from '../src/auth/password.service';

/**
 * Staff and doctor session revocation.
 *
 * Before this, privileged sessions were a bare HMAC access token: no refresh
 * token, no logout route, no revocation list. Verification touched only the
 * signature and the expiry, so a leaked staff token stayed usable for its full
 * hour and neither a password change nor firing the person had any server-side
 * effect. Clearing the desktop vault ended the session on that machine only.
 *
 * The properties locked in here:
 *   1. privileged logins issue a rotating refresh token, like patients already did
 *   2. logout kills the presented access token immediately, not at its expiry
 *   3. logout is scoped to one session — signing out here does not sign you out there
 *   4. logout is tolerant: no token, expired token, garbage token all answer ok
 *   5. refresh rotates, and the consumed refresh token dies
 *   6. a refresh token cannot be redeemed at another flow's route
 *   7. a password change ends every existing session of that account
 *   8. deleting an account ends its sessions and its ability to refresh
 *   9. a role change ends existing sessions (role travels inside the token)
 */
describe('Staff/doctor session revocation', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let redis: RedisService;
  let base: string;

  const STAFF_USER = `revoke-staff-${randomUUID().slice(0, 8)}`;
  const STAFF_PASS = randomBytes(18).toString('base64url');
  const ADMIN_USER = `revoke-admin-${randomUUID().slice(0, 8)}`;
  const ADMIN_PASS = randomBytes(18).toString('base64url');
  const DOCTOR_USER = `revoke-doc-${randomUUID().slice(0, 8)}`;
  const DOCTOR_PASS = randomBytes(18).toString('base64url');

  let staffId: string;
  let adminId: string;
  let doctorId: string;
  let clinicId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    await app.listen(0);
    base = await app.getUrl();

    const passwords = app.get(PasswordService);
    const clinic = await prisma.clinic.findFirstOrThrow({
      select: { id: true, hospitalId: true },
    });
    clinicId = clinic.id;

    staffId = (
      await prisma.staff.create({
        data: {
          username: STAFF_USER,
          name: 'Revocation Desk',
          role: StaffRole.RECEPTIONIST,
          clinicId: clinic.id,
          hospitalId: clinic.hospitalId,
          loginCredentials: await passwords.hash(STAFF_PASS),
        },
        select: { id: true },
      })
    ).id;

    adminId = (
      await prisma.staff.create({
        data: {
          username: ADMIN_USER,
          name: 'Revocation Admin',
          role: StaffRole.ADMIN,
          clinicId: clinic.id,
          hospitalId: clinic.hospitalId,
          loginCredentials: await passwords.hash(ADMIN_PASS),
        },
        select: { id: true },
      })
    ).id;

    doctorId = (
      await prisma.doctor.create({
        data: {
          clinicId: clinic.id,
          name: 'Dr Revocation',
          username: DOCTOR_USER,
          passwordHash: await passwords.hash(DOCTOR_PASS),
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    // Redis cleanup must happen before app.close() — closing disconnects the
    // client and any later command fails with "Connection is closed".
    await clearSessionKeys();
    await prisma.doctor.deleteMany({ where: { id: doctorId } });
    await prisma.staff.deleteMany({ where: { id: { in: [staffId, adminId] } } });
    await app.close();
  });

  beforeEach(clearSessionKeys);

  async function clearSessionKeys(): Promise<void> {
    for (const pattern of [
      'pfos:session:revoked:*',
      'pfos:session:epoch:*',
      'pfos:refresh:*',
      'pfos:login:fail:*',
    ]) {
      const keys = await redis.redis.keys(pattern);
      if (keys.length > 0) await redis.redis.del(...keys);
    }
  }

  type Json = Record<string, string | undefined>;

  async function post(path: string, body: unknown, token?: string) {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : {}) as Json };
  }

  async function patch(path: string, body: unknown, token: string) {
    const res = await fetch(`${base}${path}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    return { status: res.status };
  }

  async function del(path: string, token: string) {
    const res = await fetch(`${base}${path}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: res.status };
  }

  /** A route that requires a live STAFF/ADMIN session. */
  async function callProtected(token: string): Promise<number> {
    const res = await fetch(`${base}/reception/doctors`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return res.status;
  }

  const loginStaff = (username = STAFF_USER, password = STAFF_PASS) =>
    post('/auth/staff/login', { username, password });
  const loginAdmin = () => post('/auth/staff/login', { username: ADMIN_USER, password: ADMIN_PASS });
  const loginDoctor = () =>
    post('/auth/doctor/login', { username: DOCTOR_USER, password: DOCTOR_PASS });

  it('issues a refresh token on staff and doctor login', async () => {
    const staff = await loginStaff();
    expect(staff.status).toBe(201);
    expect(staff.body.token).toBeDefined();
    expect(staff.body.refreshToken).toBeDefined();

    const doctor = await loginDoctor();
    expect(doctor.status).toBe(201);
    expect(doctor.body.refreshToken).toBeDefined();
  });

  it('kills the presented access token on logout, immediately', async () => {
    const { body } = await loginStaff();
    const token = body.token as string;
    expect(await callProtected(token)).toBe(200);

    const out = await post('/auth/staff/logout', { refreshToken: body.refreshToken }, token);
    expect(out.status).toBe(201);

    // The token is still validly signed and unexpired. It must fail anyway —
    // that is the whole point of the denylist.
    expect(await callProtected(token)).toBe(401);
  });

  it('revokes only the session that logged out, not the account', async () => {
    const first = (await loginStaff()).body;
    const second = (await loginStaff()).body;

    await post('/auth/staff/logout', { refreshToken: first.refreshToken }, first.token);

    expect(await callProtected(first.token as string)).toBe(401);
    expect(await callProtected(second.token as string)).toBe(200);
  });

  it('accepts logout with no token, an expired token, or a garbage token', async () => {
    expect((await post('/auth/staff/logout', {})).status).toBe(201);
    expect((await post('/auth/staff/logout', {}, 'not-a-token')).status).toBe(201);
    expect(
      (await post('/auth/staff/logout', { refreshToken: 'never-issued' })).status,
    ).toBe(201);
  });

  it('rotates the refresh token and kills the consumed one', async () => {
    const { body } = await loginStaff();

    const refreshed = await post('/auth/staff/refresh', { refreshToken: body.refreshToken });
    expect(refreshed.status).toBe(201);
    expect(refreshed.body.token).toBeDefined();
    expect(refreshed.body.refreshToken).not.toBe(body.refreshToken);
    expect(await callProtected(refreshed.body.token as string)).toBe(200);

    // Replaying the consumed token must fail — this is what makes a stolen
    // refresh token self-limiting.
    const replay = await post('/auth/staff/refresh', { refreshToken: body.refreshToken });
    expect(replay.status).toBe(401);
  });

  it('refuses a refresh token presented at another flow’s route', async () => {
    const doctor = (await loginDoctor()).body;

    const wrongRoute = await post('/auth/staff/refresh', { refreshToken: doctor.refreshToken });
    expect(wrongRoute.status).toBe(401);

    // And it is burned, not merely rejected: a token that turned up at the
    // wrong door does not get a second attempt at the right one.
    const rightRoute = await post('/auth/doctor/refresh', { refreshToken: doctor.refreshToken });
    expect(rightRoute.status).toBe(401);
  });

  it('refreshes a doctor session and keeps it usable', async () => {
    const doctor = (await loginDoctor()).body;
    const refreshed = await post('/auth/doctor/refresh', { refreshToken: doctor.refreshToken });

    expect(refreshed.status).toBe(201);
    const res = await fetch(`${base}/doctor/me`, {
      headers: { authorization: `Bearer ${refreshed.body.token}` },
    });
    expect(res.status).toBe(200);
  });

  it('ends every existing session when an admin changes the password', async () => {
    const victim = (await loginStaff()).body;
    const otherDevice = (await loginStaff()).body;
    const admin = (await loginAdmin()).body;
    expect(await callProtected(victim.token as string)).toBe(200);

    const newPass = randomBytes(18).toString('base64url');
    const changed = await patch(
      `/admin/staff/${staffId}`,
      { password: newPass },
      admin.token as string,
    );
    expect(changed.status).toBe(200);

    // Both sessions die, including the one on a device the admin never saw.
    expect(await callProtected(victim.token as string)).toBe(401);
    expect(await callProtected(otherDevice.token as string)).toBe(401);

    // And the refresh token cannot mint a replacement.
    const refreshed = await post('/auth/staff/refresh', { refreshToken: victim.refreshToken });
    expect(refreshed.status).toBe(401);

    // The account itself still works with the new credential.
    const relogin = await loginStaff(STAFF_USER, newPass);
    expect(relogin.status).toBe(201);
    expect(await callProtected(relogin.body.token as string)).toBe(200);

    // Restore the fixture password for the remaining tests.
    await patch(`/admin/staff/${staffId}`, { password: STAFF_PASS }, admin.token as string);
  });

  it('ends existing sessions when the role changes', async () => {
    const session = (await loginStaff()).body;
    const admin = (await loginAdmin()).body;
    expect(await callProtected(session.token as string)).toBe(200);

    // Any role write ends the sessions, because the role is baked into the
    // issued token: a demotion that left the old token working would be
    // cosmetic for up to an hour.
    await patch(`/admin/staff/${staffId}`, { role: 'RECEPTIONIST' }, admin.token as string);
    expect(await callProtected(session.token as string)).toBe(401);
  });

  it('ends sessions when the account is deleted', async () => {
    const passwords = app.get(PasswordService);
    const doomedPass = randomBytes(18).toString('base64url');
    const doomedUser = `revoke-doomed-${randomUUID().slice(0, 8)}`;
    const doomed = await prisma.staff.create({
      data: {
        username: doomedUser,
        name: 'Departing Staff',
        role: StaffRole.RECEPTIONIST,
        clinicId,
        hospitalId: (await prisma.clinic.findFirstOrThrow({ where: { id: clinicId } })).hospitalId,
        loginCredentials: await passwords.hash(doomedPass),
      },
      select: { id: true },
    });

    const session = (await loginStaff(doomedUser, doomedPass)).body;
    expect(await callProtected(session.token as string)).toBe(200);

    const admin = (await loginAdmin()).body;
    expect((await del(`/admin/staff/${doomed.id}`, admin.token as string)).status).toBe(204);

    expect(await callProtected(session.token as string)).toBe(401);
    expect(
      (await post('/auth/staff/refresh', { refreshToken: session.refreshToken })).status,
    ).toBe(401);
  });
});
