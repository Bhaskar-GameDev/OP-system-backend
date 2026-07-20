import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * /integrations/* admin operational endpoints. In the test env no external
 * credentials are configured, so the test sends MUST take the dev-fallback path
 * (log instead of call out) and never reach a real provider. Also proves the
 * ADMIN-only guard: doctor and patient are rejected.
 */
describe('Integrations admin endpoints (full stack)', () => {
  let app: INestApplication;
  let url: string;
  let tokens: AuthTokenService;

  let adminToken = '';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    tokens = app.get(AuthTokenService);
    adminToken = tokens.sign({ sub: 'ig-admin', role: 'ADMIN', clinicId: 'ig-clinic' });
  });

  afterAll(async () => {
    await app.close();
  });

  function get(path: string, token?: string) {
    return fetch(`${url}${path}`, token ? { headers: { authorization: `Bearer ${token}` } } : undefined);
  }
  function post(path: string, body: unknown, token?: string) {
    return fetch(`${url}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('GET /integrations/health reports config presence for all three', async () => {
    const res = await get('/integrations/health', adminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      msg91: { configured: boolean };
      razorpay: { configured: boolean };
      fcm: { configured: boolean };
    };
    expect(body.msg91).toHaveProperty('configured');
    expect(body.razorpay).toHaveProperty('configured');
    expect(body.fcm).toHaveProperty('configured');
    // no credentials in the test env -> not configured
    expect(body.msg91.configured).toBe(false);
    expect(body.razorpay.configured).toBe(false);
  });

  it('GET /integrations/health?probe=true deep-probes; reports dev-fallback with no creds', async () => {
    const res = await get('/integrations/health?probe=true', adminToken);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      probe: {
        msg91: { ok: boolean; mode: string };
        razorpay: { ok: boolean; mode: string };
        fcm: { ok: boolean; mode: string };
      };
    };
    // No credentials in the test env -> every probe takes the dev-fallback path
    // (no outbound calls), never throws, and says so.
    expect(body.probe.msg91.mode).toBe('dev-fallback');
    expect(body.probe.razorpay.mode).toBe('dev-fallback');
    expect(body.probe.razorpay.ok).toBe(false);
    expect(['dev-fallback', 'live']).toContain(body.probe.fcm.mode);
  });

  it('POST /integrations/test-sms uses the dev fallback (no real send)', async () => {
    const res = await post('/integrations/test-sms', { mobile: '9876543210' }, adminToken);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('dev-fallback');
  });

  it('POST /integrations/test-sms with no mobile and no default -> 400', async () => {
    const res = await post('/integrations/test-sms', {}, adminToken);
    // INTEGRATIONS_TEST_MOBILE is unset in tests -> required
    expect(res.status).toBe(400);
  });

  it('POST /integrations/test-push returns ok without throwing (fallback or live)', async () => {
    // FCM_SERVICE_ACCOUNT_PATH may be set in .env, but with no real service
    // account the sender logs and returns — a push must never throw to the admin.
    const res = await post('/integrations/test-push', { token: 'fake-device-token' }, adminToken);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(['dev-fallback', 'live']).toContain(body.mode);
  });

  it('POST /integrations/test-push without a token -> 400', async () => {
    expect((await post('/integrations/test-push', {}, adminToken)).status).toBe(400);
  });

  it('ADMIN-only guard: no token -> 401, doctor -> 403, patient -> 403', async () => {
    expect((await get('/integrations/health')).status).toBe(401);

    const doctor = tokens.sign({ sub: 'ig-doc', role: 'DOCTOR', doctorId: 'ig-doc' });
    expect((await get('/integrations/health', doctor)).status).toBe(403);

    const patient = tokens.sign({ sub: 'ig-pt', role: 'PATIENT' });
    expect((await get('/integrations/health', patient)).status).toBe(403);

    // a non-admin must not be able to trigger sends either
    expect((await post('/integrations/test-sms', { mobile: '9876543210' }, doctor)).status).toBe(403);
  });
});
