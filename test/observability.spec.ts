import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { StaffRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { PasswordService } from '../src/auth/password.service';
import { AllExceptionsFilter } from '../src/common/errors/all-exceptions.filter';
import { JsonLogger } from '../src/common/observability/json-logger';
import { normalisePath } from '../src/common/observability/http-metrics.middleware';
import { HealthController } from '../src/common/observability/health.controller';
import {
  REQUEST_ID_HEADER,
  resolveRequestId,
  runWithRequestContext,
} from '../src/common/observability/request-context';

/**
 * Observability: correlation ids, structured logs, metrics, health.
 *
 * Before this the backend logged unstructured lines to stdout with no request
 * id, exposed no metrics at all, and its container healthcheck treated any HTTP
 * response — including 401 and 404 — as healthy. Production problems were
 * detected by users, and "when did the error rate rise" had no answer.
 *
 * Properties locked in here:
 *   1. every response carries a request id, and an inbound one is preserved
 *   2. a forged or malformed inbound id is replaced, never echoed
 *   3. error bodies carry the id, so a user can quote the string that finds the log
 *   4. log lines are JSON and carry the id of the request they belong to
 *   5. /metrics reports real request, auth and socket series
 *   6. metric labels are bounded — no ids, no raw URLs
 *   7. /metrics is not open by accident
 *   8. readiness actually checks Postgres and Redis
 */
describe('Observability', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;

  const STAFF_USER = `obs-${randomUUID().slice(0, 8)}`;
  const STAFF_PASS = randomBytes(18).toString('base64url');
  let staffId: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);

    const clinic = await prisma.clinic.findFirstOrThrow({
      select: { id: true, hospitalId: true },
    });
    staffId = (
      await prisma.staff.create({
        data: {
          username: STAFF_USER,
          name: 'Observability Desk',
          role: StaffRole.RECEPTIONIST,
          clinicId: clinic.id,
          hospitalId: clinic.hospitalId,
          loginCredentials: await app.get(PasswordService).hash(STAFF_PASS),
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    const keys = await redis.redis.keys('pfos:login:fail:*');
    if (keys.length > 0) await redis.redis.del(...keys);
    await prisma.staff.deleteMany({ where: { id: staffId } });
    await app.close();
  });

  // ── correlation id ───────────────────────────────────────

  it('returns a request id on every response', async () => {
    const res = await fetch(`${url}/clinics`);
    expect(res.headers.get(REQUEST_ID_HEADER)).toMatch(/^[\w.:-]{8,128}$/);
  });

  it('preserves an inbound request id so a trace stays one thread', async () => {
    const inbound = `trace-${randomUUID()}`;
    const res = await fetch(`${url}/clinics`, { headers: { [REQUEST_ID_HEADER]: inbound } });
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(inbound);
  });

  it('replaces a malformed inbound id rather than echoing it into the logs', () => {
    // Newlines would let a caller forge a log record; the others are simply not
    // ids. None of them is preserved.
    for (const hostile of ['a\nb', 'x'.repeat(200), '<script>', 'short', '']) {
      expect(resolveRequestId(hostile)).not.toBe(hostile);
      expect(resolveRequestId(hostile)).toMatch(/^[\w-]{36}$/);
    }
    expect(resolveRequestId('valid-id-12345')).toBe('valid-id-12345');
  });

  it('puts the request id in the error body, matching the header', async () => {
    const res = await fetch(`${url}/clinics/does-not-exist-at-all`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { requestId?: string };
    expect(body.requestId).toBe(res.headers.get(REQUEST_ID_HEADER));
  });

  // ── structured logging ───────────────────────────────────

  it('logs one JSON object per line, carrying the active request id', () => {
    const written: string[] = [];
    const sink = { write: (line: string) => written.push(line) };
    const logger = new JsonLogger(sink, sink);

    runWithRequestContext({ requestId: 'req-abc-123' }, () => {
      logger.log('booking confirmed', 'PaymentsService');
      logger.error('boom', 'stack trace here', 'PaymentsService');
    });
    logger.log('cron tick', 'ArchivalService'); // outside any request

    const lines = written.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({
      level: 'info',
      requestId: 'req-abc-123',
      ctx: 'PaymentsService',
      msg: 'booking confirmed',
    });
    expect(lines[1]).toMatchObject({ level: 'error', stack: 'stack trace here' });
    // Background work has no request; an invented id would be worse than none.
    expect(lines[2].requestId).toBeUndefined();
  });

  // ── metrics ──────────────────────────────────────────────

  it('exposes request, auth and process metrics', async () => {
    await fetch(`${url}/clinics`);
    await fetch(`${url}/auth/staff/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: STAFF_USER, password: 'definitely-wrong' }),
    });

    const body = await (await fetch(`${url}/metrics`)).text();

    expect(body).toContain('pfos_http_request_duration_seconds_bucket');
    expect(body).toContain('pfos_auth_failures_total{scope="staff",reason="invalid_credentials"}');
    expect(body).toContain('pfos_socket_connections');
    expect(body).toContain('pfos_projection_lag_events');
    expect(body).toContain('pfos_process_cpu_user_seconds_total');
  });

  it('keeps metric labels bounded and free of identifiers', async () => {
    // A label per booking id would both explode the series count and turn the
    // metrics endpoint into a patient register.
    expect(normalisePath('/bookings/9f1c2d3e-4a5b-6c7d-8e9f-0a1b2c3d4e5f/cancel')).toBe(
      '/bookings/:id/cancel',
    );
    expect(normalisePath('/admin/staff/12345')).toBe('/admin/staff/:id');
    expect(normalisePath('/clinics')).toBe('/clinics');
    expect(normalisePath('/')).toBe('/');

    const booking = randomUUID();
    await fetch(`${url}/queue/my-status?bookingId=${booking}`);
    const body = await (await fetch(`${url}/metrics`)).text();
    expect(body).not.toContain(booking);
  });

  it('requires a token for /metrics once METRICS_TOKEN is configured', async () => {
    // Restarting the app to change config would be slow; the rule itself is what
    // matters, and it reads the value per request.
    const config = app.get(ConfigService) as unknown as { get: (k: string) => unknown };
    const original = config.get;
    (config as { get: unknown }).get = (key: string) =>
      key === 'METRICS_TOKEN' ? 'secret-scrape-token' : original.call(config, key);

    try {
      expect((await fetch(`${url}/metrics`)).status).toBe(401);
      expect(
        (
          await fetch(`${url}/metrics`, {
            headers: { authorization: 'Bearer wrong-token' },
          })
        ).status,
      ).toBe(401);
      expect(
        (
          await fetch(`${url}/metrics`, {
            headers: { authorization: 'Bearer secret-scrape-token' },
          })
        ).status,
      ).toBe(200);
    } finally {
      (config as { get: unknown }).get = original;
    }
  });

  // ── health ───────────────────────────────────────────────

  it('answers liveness without touching a dependency', async () => {
    const res = await fetch(`${url}/health`);
    expect(res.status).toBe(200);
    expect((await res.json()) as { status: string }).toMatchObject({ status: 'ok' });
  });

  it('reports readiness only when Postgres and Redis both answer', async () => {
    const res = await fetch(`${url}/health/ready`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      dependencies: Record<string, { status: string; latencyMs: number }>;
    };
    expect(body.status).toBe('ok');
    expect(body.dependencies.postgres.status).toBe('up');
    expect(body.dependencies.redis.status).toBe('up');
    expect(body.dependencies.postgres.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('reports 503 and names the failing dependency when one is down', async () => {
    const health = app.get(HealthController);
    const broken = jest
      .spyOn(redis.redis, 'ping')
      .mockRejectedValue(Object.assign(new Error('down'), { name: 'ReplyError' }));

    try {
      await expect(health.ready()).rejects.toMatchObject({
        response: {
          status: 'degraded',
          dependencies: { redis: { status: 'down' } },
        },
      });
    } finally {
      broken.mockRestore();
    }
  });
});
