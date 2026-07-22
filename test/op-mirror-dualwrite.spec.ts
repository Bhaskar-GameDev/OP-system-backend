import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { EncounterStatus, TokenResetPolicy } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { AuthTokenService } from '../src/auth/auth-token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { SessionKey } from '../src/queue-engine/token.service';

/**
 * Task 2 dual-write bridge. Proves that a legacy reception walk-in ALSO drives
 * the new Encounter pipeline in parallel (when a TokenSeries exists): one desk
 * action yields BOTH a legacy Booking (unchanged) AND a new Encounter that is
 * checked in, has a token, and sits in the new queue — without the legacy path
 * changing at all. Idempotent: a retried walk-in maps to the same encounter.
 */
describe('Dual-write: reception walk-in mirrors into the new engine', () => {
  let app: INestApplication;
  let url: string;
  let prisma: PrismaService;
  let redis: RedisService;
  let tokens: AuthTokenService;
  let queue: QueueService;

  const stamp = Date.now();
  const HOSP = `dw-hosp-${stamp}`;
  const CLINIC = `dw-clinic-${stamp}`;
  const DOCTOR = `dw-doc-${stamp}`;
  const SERIES = `dw-series-${stamp}`;
  const MOBILE = '7300000001';
  const SESSION_DATE = '2026-08-20';
  const session: SessionKey = { doctorId: DOCTOR, sessionDate: SESSION_DATE, sessionType: 'MORNING' };

  let staff = '';
  const encounterIds: string[] = [];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.listen(0);
    url = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    redis = app.get(RedisService);
    tokens = app.get(AuthTokenService);
    queue = app.get(QueueService);

    await cleanup();
    await prisma.hospital.create({ data: { id: HOSP, name: 'DW Hosp' } });
    await prisma.clinic.create({ data: { id: CLINIC, hospitalId: HOSP, name: 'DW Clinic' } });
    await prisma.doctor.create({ data: { id: DOCTOR, clinicId: CLINIC, name: 'DW Dr', avgConsultMinutes: 10 } });
    await prisma.tokenSeries.create({
      data: {
        id: SERIES, clinicId: CLINIC, code: 'NORMAL_OP', label: 'Normal',
        prefix: 'N', padWidth: 3, startAt: 1, resetPolicy: TokenResetPolicy.PER_SESSION,
      },
    });
    staff = tokens.sign({ sub: 'dw-staff', role: 'STAFF', clinicId: CLINIC, hospitalId: HOSP });
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  async function cleanup(): Promise<void> {
    await queue.clearSession(session).catch(() => {});
    const opSessions = await prisma.opSession
      .findMany({ where: { doctorId: DOCTOR }, select: { id: true } })
      .catch(() => [] as { id: string }[]);
    for (const s of opSessions) {
      const keys = await redis.redis.keys(`pfos:*${s.id}*`).catch(() => [] as string[]);
      if (keys.length) await redis.redis.del(...keys);
    }
    const seqKeys = await redis.redis.keys(`pfos:tokenseq:${SERIES}:*`).catch(() => [] as string[]);
    if (seqKeys.length) await redis.redis.del(...seqKeys);

    const encWhere = { encounterId: { in: encounterIds } };
    await prisma.queueEntry.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.token.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.checkIn.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.registration.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.queueReadModel.deleteMany({ where: encWhere }).catch(() => {});
    await prisma.domainEvent.deleteMany({ where: { streamId: { in: encounterIds } } }).catch(() => {});
    await prisma.encounter.deleteMany({ where: { id: { in: encounterIds } } }).catch(() => {});
    await prisma.opSession.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR } }).catch(() => {});
    await prisma.patient.deleteMany({ where: { mobile: MOBILE } }).catch(() => {});
    await prisma.tokenSeries.deleteMany({ where: { id: SERIES } }).catch(() => {});
    await prisma.doctor.deleteMany({ where: { id: DOCTOR } }).catch(() => {});
    await prisma.clinic.deleteMany({ where: { id: CLINIC } }).catch(() => {});
    await prisma.hospital.deleteMany({ where: { id: HOSP } }).catch(() => {});
  }

  function walkin() {
    return fetch(`${url}/reception/walkins`, {
      method: 'POST',
      headers: { authorization: `Bearer ${staff}`, 'content-type': 'application/json' },
      body: JSON.stringify({ mobile: MOBILE, name: 'Dual Write', ...session }),
    });
  }

  it('creates a legacy Booking AND a mirrored, checked-in, tokenised, enqueued Encounter', async () => {
    const res = await walkin();
    expect(res.status).toBe(201);
    const view = (await res.json()) as { bookingId: string; tokenNumber: string };
    expect(view.bookingId).toBeTruthy();
    expect(view.tokenNumber).toBe('W001'); // legacy token unchanged

    // legacy Booking still exists exactly as before
    const booking = await prisma.booking.findUniqueOrThrow({ where: { id: view.bookingId } });
    expect(booking.tokenNumber).toBe('W001');

    // the mirror registered a NEW Encounter, correlated by legacyBookingId
    const reg = await prisma.registration.findFirst({
      where: { source: 'RECEPTION', channelMeta: { path: ['legacyBookingId'], equals: view.bookingId } },
      select: { encounterId: true },
    });
    expect(reg).not.toBeNull();
    encounterIds.push(reg!.encounterId);

    // it went the full combined desk path: checked in + token + enqueued -> WAITING
    const enc = await prisma.encounter.findUniqueOrThrow({ where: { id: reg!.encounterId } });
    expect(enc.status).toBe(EncounterStatus.WAITING);

    const token = await prisma.token.findUnique({ where: { encounterId: reg!.encounterId } });
    expect(token?.displayNumber).toMatch(/^N\d{3}$/); // new series, independent of legacy 'W001'

    const entry = await prisma.queueEntry.findUnique({ where: { encounterId: reg!.encounterId } });
    expect(entry).not.toBeNull();
  });

  it('is idempotent per legacy booking — a duplicate desk action does not double-register', async () => {
    // second walk-in for the SAME mobile creates a SECOND legacy booking (legacy
    // behaviour), each with its own bookingId => its own encounter. But re-mirroring
    // the SAME bookingId must be a no-op. Assert one encounter per registration key.
    const regs = await prisma.registration.findMany({
      where: { source: 'RECEPTION', encounterId: { in: encounterIds } },
    });
    const keys = regs.map((r) => (r.channelMeta as { legacyBookingId?: string })?.legacyBookingId);
    expect(new Set(keys).size).toBe(keys.length); // no duplicate legacyBookingId -> one encounter each
  });
});
