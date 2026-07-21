/**
 * Credentials this suite must run WITHOUT. Neutralised at module scope, before
 * ConfigModule boots in beforeAll.
 *
 * This is a safety requirement, not a convenience. These endpoints really send:
 * POST /integrations/test-sms would put a real SMS on a real handset, and
 * ?probe=true makes an authenticated call to api.razorpay.com. A developer with
 * production credentials in .env — which is now the normal case — would spend
 * money and text a stranger just by running the suite. Neutralising here means
 * the dev-fallback path is the only one these tests can reach.
 *
 * Set to '' rather than deleted: dotenv skips keys already present in
 * process.env, so an empty assignment survives ConfigModule's .env load, while a
 * delete would simply be refilled from the file.
 */
const NEUTRALISED = [
  'MSG91_AUTH_KEY',
  'MSG91_SENDER_ID',
  'MSG91_OTP_TEMPLATE_ID',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'FCM_SERVICE_ACCOUNT_JSON',
  'FCM_SERVICE_ACCOUNT_PATH',
  'INTEGRATIONS_TEST_MOBILE',
] as const;

const originalEnv = new Map<string, string | undefined>();
for (const key of NEUTRALISED) {
  originalEnv.set(key, process.env[key]);
  process.env[key] = '';
}

import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { AppModule } from '../src/app.module';
import { AuthTokenService } from '../src/auth/auth-token.service';

/**
 * /integrations/* admin operational endpoints.
 *
 * This suite deliberately exercises the UNCONFIGURED path: with no external
 * credentials the test sends must take the dev-fallback route (log instead of
 * call out) and never reach a real provider. The credentials are stripped above
 * so that holds whatever the ambient .env contains. Also proves the ADMIN-only
 * guard: doctor and patient are rejected.
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
    // Restore, so a later suite in the same worker sees the real environment.
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
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
    // credentials stripped for this suite -> all three report unconfigured
    expect(body.msg91.configured).toBe(false);
    expect(body.razorpay.configured).toBe(false);
    expect(body.fcm.configured).toBe(false);
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
    // No credentials -> every probe takes the dev-fallback path (crucially, no
    // outbound call to api.razorpay.com), never throws, and says so.
    expect(body.probe.msg91.mode).toBe('dev-fallback');
    expect(body.probe.razorpay.mode).toBe('dev-fallback');
    expect(body.probe.razorpay.ok).toBe(false);
    expect(body.probe.fcm.mode).toBe('dev-fallback');
    expect(body.probe.fcm.ok).toBe(false);
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

  it('POST /integrations/test-push uses the dev fallback (no real push)', async () => {
    // With no service account the sender logs and returns — a push must never
    // throw to the admin, and must never dispatch via FCM.
    const res = await post('/integrations/test-push', { token: 'fake-device-token' }, adminToken);
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; mode: string };
    expect(body.ok).toBe(true);
    expect(body.mode).toBe('dev-fallback');
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
