import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * /me patient self-service profile. GET returns the caller's record; PATCH
 * updates name/age/gender with validation; mobile is read-only. Strictly
 * self-scoped (id from the JWT), PATIENT-only.
 */
describe('Patient profile /me (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let tokens: AuthTokenService;

  const PATIENT = 'me-pt-1';
  let patientToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = app.get(PrismaService);
    tokens = app.get(AuthTokenService);

    await cleanup();
    // a freshly-registered patient starts with an empty name (OTP flow)
    await prisma.patient.create({ data: { id: PATIENT, name: '', mobile: '9123456780' } });
    patientToken = tokens.sign({ sub: PATIENT, role: 'PATIENT' });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await prisma.patient.deleteMany({ where: { id: PATIENT } });
  }

  function getMe(token: string) {
    return fetch(`${url}/me`, { headers: { authorization: `Bearer ${token}` } });
  }
  function patchMe(token: string, body: unknown) {
    return fetch(`${url}/me`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('GET returns the empty-name record for a new patient', async () => {
    const res = await getMe(patientToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ id: PATIENT, name: '', mobile: '9123456780' });
    expect(body.age).toBeNull();
    expect(body.gender).toBeNull();
  });

  it('PATCH sets name/age/gender and GET reflects it', async () => {
    const res = await patchMe(patientToken, { name: 'Asha Rao', age: 34, gender: 'FEMALE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'Asha Rao', age: 34, gender: 'FEMALE', mobile: '9123456780' });

    const after = (await (await getMe(patientToken)).json()) as Record<string, unknown>;
    expect(after).toMatchObject({ name: 'Asha Rao', age: 34, gender: 'FEMALE' });
  });

  it('PATCH trims the name', async () => {
    const res = await patchMe(patientToken, { name: '  Bob Singh  ' });
    const body = (await res.json()) as { name: string };
    expect(body.name).toBe('Bob Singh');
  });

  it('rejects an empty/whitespace name (400)', async () => {
    expect((await patchMe(patientToken, { name: '' })).status).toBe(400);
    expect((await patchMe(patientToken, { name: '   ' })).status).toBe(400);
  });

  it('rejects an out-of-range / non-integer age (400)', async () => {
    expect((await patchMe(patientToken, { age: 200 })).status).toBe(400);
    expect((await patchMe(patientToken, { age: -1 })).status).toBe(400);
    expect((await patchMe(patientToken, { age: 3.5 })).status).toBe(400);
  });

  it('rejects an invalid gender (400)', async () => {
    expect((await patchMe(patientToken, { gender: 'X' })).status).toBe(400);
  });

  it('allows clearing age/gender with null', async () => {
    const res = await patchMe(patientToken, { age: null, gender: null });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.age).toBeNull();
    expect(body.gender).toBeNull();
  });

  it('rejects an empty update body (400)', async () => {
    expect((await patchMe(patientToken, {})).status).toBe(400);
  });

  it('role guard: no token -> 401, staff -> 403, doctor -> 403', async () => {
    expect((await fetch(`${url}/me`)).status).toBe(401);

    const staff = tokens.sign({ sub: 'me-staff', role: 'STAFF', clinicId: 'me-clinic' });
    expect((await getMe(staff)).status).toBe(403);

    const doctor = tokens.sign({ sub: 'me-doc', role: 'DOCTOR', doctorId: 'me-doc' });
    expect((await getMe(doctor)).status).toBe(403);
  });
});
