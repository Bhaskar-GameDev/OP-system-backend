import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { AddressInfo } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { io, Socket } from 'socket.io-client';
import { StaffRole } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { AuthService } from '../src/auth/auth.service';
import { PasswordService } from '../src/auth/password.service';
import { SessionRevocationService } from '../src/auth/session-revocation.service';
import { QueueGateway } from '../src/queue-engine/queue.gateway';
import {
  DEFAULT_CORS_ORIGINS,
  parseCorsOrigins,
} from '../src/common/config/cors-origins';

/**
 * WebSocket session hardening.
 *
 * The gateway used to verify a token exactly once, at connect, and store the
 * claims on the socket forever after. A dashboard opened at 09:00 with a 1-hour
 * token was still receiving the clinic's full live queue at 18:00 — and because
 * privileged sessions could not be revoked at all, a stolen token bought an
 * unbounded live feed of patient flow. It also declared `cors: { origin: '*' }`,
 * overriding the HTTP layer's allowlist, so any web page could open that feed.
 *
 * Properties locked in here:
 *   1. the socket layer uses the same origin allowlist as HTTP — never '*'
 *   2. a revoked token cannot open a socket
 *   3. a session revoked mid-connection cannot join a room afterwards
 *   4. the periodic sweep disconnects sockets whose session has ended
 *   5. tokens are not accepted in the query string
 */
describe('WebSocket session hardening', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;
  let auth: AuthService;
  let revocation: SessionRevocationService;
  let gateway: QueueGateway;

  const STAFF_USER = `ws-hard-${randomUUID().slice(0, 8)}`;
  const STAFF_PASS = randomBytes(18).toString('base64url');
  let staffId: string;
  const sockets: Socket[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useWebSocketAdapter(new IoAdapter(app));
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    auth = app.get(AuthService);
    revocation = app.get(SessionRevocationService);
    gateway = app.get(QueueGateway);

    const clinic = await prisma.clinic.findFirstOrThrow({
      select: { id: true, hospitalId: true },
    });
    staffId = (
      await prisma.staff.create({
        data: {
          username: STAFF_USER,
          name: 'Socket Hardening Desk',
          role: StaffRole.RECEPTIONIST,
          clinicId: clinic.id,
          hospitalId: clinic.hospitalId,
          loginCredentials: await app.get(PasswordService).hash(STAFF_PASS),
        },
        select: { id: true },
      })
    ).id;
  });

  afterEach(() => {
    for (const s of sockets.splice(0)) s.close();
  });

  afterAll(async () => {
    for (const pattern of ['pfos:session:*', 'pfos:refresh:*', 'pfos:login:fail:*']) {
      const keys = await redis.redis.keys(pattern);
      if (keys.length > 0) await redis.redis.del(...keys);
    }
    await prisma.staff.deleteMany({ where: { id: staffId } });
    await app.close();
  });

  const login = async (): Promise<string> =>
    (await auth.staffLogin(STAFF_USER, STAFF_PASS)).token;

  /** Connect and settle: resolves 'connected' or the first refusal. */
  function open(options: Parameters<typeof io>[1]): Promise<{
    socket: Socket;
    outcome: 'connected' | 'error' | 'disconnected';
  }> {
    const socket = io(url, { transports: ['websocket'], forceNew: true, ...options });
    sockets.push(socket);
    return new Promise((resolve) => {
      socket.on('connect', () => {
        // The server disconnects an unauthorized socket right after the
        // handshake, so a 'connect' alone is not proof of admission — wait a
        // beat to see whether it survives.
        setTimeout(() => {
          resolve({ socket, outcome: socket.connected ? 'connected' : 'disconnected' });
        }, 300);
      });
      socket.on('connect_error', () => resolve({ socket, outcome: 'error' }));
    });
  }

  it('uses the configured origin allowlist, never a wildcard', () => {
    expect(parseCorsOrigins(undefined)).toEqual(DEFAULT_CORS_ORIGINS);
    expect(parseCorsOrigins('https://a.example, https://b.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
    expect(parseCorsOrigins('')).toEqual(DEFAULT_CORS_ORIGINS);
    expect(parseCorsOrigins(undefined)).not.toContain('*');
  });

  it('refuses a socket whose session was already revoked', async () => {
    const token = await login();
    await revocation.revokeAllForSubject(staffId);

    const { outcome } = await open({ auth: { token } });
    expect(outcome).not.toBe('connected');
  });

  it('refuses a join once the session is revoked mid-connection', async () => {
    const token = await login();
    const { socket, outcome } = await open({ auth: { token } });
    expect(outcome).toBe('connected');

    // Revoked after the socket is already up — exactly the case connect-time-only
    // verification missed.
    await revocation.revokeAllForSubject(staffId);

    const rejected = await new Promise<boolean>((resolve) => {
      socket.on('error', () => resolve(true));
      socket.on('disconnect', () => resolve(true));
      socket.on('snapshot', () => resolve(false));
      socket.emit('join', {
        doctorId: 'any-doctor',
        sessionDate: '2026-08-10',
        sessionType: 'MORNING',
      });
      setTimeout(() => resolve(false), 1500);
    });
    expect(rejected).toBe(true);
  });

  it('disconnects a live socket whose session ended, without waiting for it to drop', async () => {
    const token = await login();
    const { socket, outcome } = await open({ auth: { token } });
    expect(outcome).toBe('connected');

    await revocation.revokeAllForSubject(staffId);

    // The sweep runs on an interval in production; calling it directly proves
    // what it does when it fires, without a minute of waiting.
    const dropped = new Promise<boolean>((resolve) => {
      socket.on('disconnect', () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });
    await gateway.sweepExpiredSockets();
    expect(await dropped).toBe(true);
  });

  it('does not accept a session token from the query string', async () => {
    const token = await login();
    const { outcome } = await open({ query: { token } });
    expect(outcome).not.toBe('connected');
  });
});
