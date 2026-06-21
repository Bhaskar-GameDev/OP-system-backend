import { ConfigService } from '@nestjs/config';
import { BookingStatus, BookingSource } from '@prisma/client';
import { RedisService } from '../src/common/redis/redis.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { QueueEventsService } from '../src/queue-engine/queue-events.service';

/**
 * Step 3.6 — DONE / queue advancement, against REAL Redis + Postgres.
 *
 * Proves: status lifecycle (BOOKED -> ACTIVE -> COMPLETED), consultation
 * timestamps captured at the right moments, and — critically — that concurrent
 * DONE presses never skip or double-complete a patient (atomic check-and-pop).
 */
describe('ConsultationService — DONE advancement (real Redis + Postgres)', () => {
  let redisService: RedisService;
  let prisma: PrismaService;
  let queueService: QueueService;
  let consult: ConsultationService;

  const CLINIC_ID = 'done-test-clinic';
  const DOCTOR_ID = 'done-test-doctor';
  const session: SessionKey = {
    doctorId: DOCTOR_ID,
    sessionDate: '2026-06-19',
    sessionType: 'MORNING',
  };

  const SOURCES: TokenSource[] = [
    TokenSource.APP,
    TokenSource.WALK_IN,
    TokenSource.VOICE,
  ];
  const toBookingSource: Record<TokenSource, BookingSource> = {
    [TokenSource.APP]: BookingSource.APP,
    [TokenSource.WALK_IN]: BookingSource.WALK_IN,
    [TokenSource.VOICE]: BookingSource.VOICE,
  };

  beforeAll(async () => {
    const config = new ConfigService({
      REDIS_HOST: process.env.REDIS_HOST ?? 'localhost',
      REDIS_PORT: Number(process.env.REDIS_PORT ?? 6379),
      REDIS_PASSWORD: process.env.REDIS_PASSWORD ?? '',
    });
    redisService = new RedisService(config);
    redisService.onModuleInit();
    prisma = new PrismaService();
    await prisma.onModuleInit();
    queueService = new QueueService(redisService);
    consult = new ConsultationService(
      prisma,
      queueService,
      redisService,
      new QueueEventsService(),
    );

    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'DONE Test Clinic' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: {
        id: DOCTOR_ID,
        clinicId: CLINIC_ID,
        name: 'Dr DONE',
        avgConsultMinutes: 5,
      },
      update: {},
    });
  });

  beforeEach(async () => {
    await queueService.clearSession(session);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'done-pt-' } } });
  });

  afterAll(async () => {
    await queueService.clearSession(session);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'done-pt-' } } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await prisma.onModuleDestroy();
    await redisService.onModuleDestroy();
  });

  /** Create a BOOKED booking + its patient, return bookingId. */
  async function makeBooking(i: number, source: TokenSource): Promise<string> {
    const patientId = `done-pt-${i}`;
    await prisma.patient.create({
      data: { id: patientId, name: `Patient ${i}`, mobile: `9${Date.now()}${i}` },
    });
    const b = await prisma.booking.create({
      data: {
        patientId,
        doctorId: DOCTOR_ID,
        source: toBookingSource[source],
        sessionDate: new Date(session.sessionDate),
        sessionType: 'MORNING',
        status: BookingStatus.BOOKED,
      },
    });
    return b.id;
  }

  it('first enqueue is promoted ACTIVE with started_at; rest stay BOOKED', async () => {
    const id0 = await makeBooking(0, TokenSource.APP);
    const id1 = await makeBooking(1, TokenSource.WALK_IN);

    const e0 = await consult.enqueueBooking(TokenSource.APP, session, id0);
    const e1 = await consult.enqueueBooking(TokenSource.WALK_IN, session, id1);

    expect(e0.isFront).toBe(true);
    expect(e1.isFront).toBe(false);

    const b0 = await prisma.booking.findUniqueOrThrow({ where: { id: id0 } });
    const b1 = await prisma.booking.findUniqueOrThrow({ where: { id: id1 } });

    expect(b0.status).toBe(BookingStatus.ACTIVE);
    expect(b0.consultationStartedAt).not.toBeNull();
    expect(b0.consultationEndedAt).toBeNull();

    expect(b1.status).toBe(BookingStatus.BOOKED);
    expect(b1.consultationStartedAt).toBeNull();
  });

  it('DONE completes front, stamps ended_at, promotes next to ACTIVE', async () => {
    const id0 = await makeBooking(0, TokenSource.APP);
    const id1 = await makeBooking(1, TokenSource.WALK_IN);
    await consult.enqueueBooking(TokenSource.APP, session, id0); // A001 active
    await consult.enqueueBooking(TokenSource.WALK_IN, session, id1); // W001 booked

    const res = await consult.markDone(session);
    expect(res.doneToken).toBe('A001');
    expect(res.doneBookingId).toBe(id0);
    expect(res.newActiveToken).toBe('W001');
    expect(res.newActiveBookingId).toBe(id1);

    const b0 = await prisma.booking.findUniqueOrThrow({ where: { id: id0 } });
    const b1 = await prisma.booking.findUniqueOrThrow({ where: { id: id1 } });

    expect(b0.status).toBe(BookingStatus.COMPLETED);
    expect(b0.consultationEndedAt).not.toBeNull();
    expect(b0.consultationStartedAt!.getTime()).toBeLessThanOrEqual(
      b0.consultationEndedAt!.getTime(),
    );
    expect(b1.status).toBe(BookingStatus.ACTIVE);
    expect(b1.consultationStartedAt).not.toBeNull();

    expect(await queueService.frontToken(session)).toBe('W001');
  });

  it('DONE on empty queue throws; DONE with wrong expectedToken throws (no advance)', async () => {
    await expect(consult.markDone(session)).rejects.toThrow(/no active patient/);

    const id0 = await makeBooking(0, TokenSource.APP);
    await consult.enqueueBooking(TokenSource.APP, session, id0);

    await expect(consult.markDone(session, 'W999')).rejects.toThrow(/not W999/);
    // queue unchanged — stale press did not advance
    expect(await queueService.frontToken(session)).toBe('A001');
    const b0 = await prisma.booking.findUniqueOrThrow({ where: { id: id0 } });
    expect(b0.status).toBe(BookingStatus.ACTIVE);
  });

  it('15 concurrent DONE presses on a 12-deep queue: no skip, no double-complete', async () => {
    const N = 12;
    const ids: string[] = [];
    for (let i = 0; i < N; i++) {
      const src = SOURCES[i % SOURCES.length];
      const id = await makeBooking(i, src);
      ids.push(id);
      await consult.enqueueBooking(src, session, id);
    }
    const ordered = await queueService.list(session);
    expect(ordered).toHaveLength(N);

    // fire MORE presses than patients, all at once
    const presses = 15;
    const settled = await Promise.allSettled(
      Array.from({ length: presses }, () => consult.markDone(session)),
    );

    const ok = settled.filter((s) => s.status === 'fulfilled') as
      PromiseFulfilledResult<Awaited<ReturnType<typeof consult.markDone>>>[];
    const rejected = settled.filter((s) => s.status === 'rejected');

    // exactly N succeed, the surplus 3 fail on an empty queue
    expect(ok).toHaveLength(N);
    expect(rejected).toHaveLength(presses - N);

    // each press completed a DISTINCT token == the whole queue, no duplicates
    const doneTokens = ok.map((r) => r.value.doneToken);
    expect(new Set(doneTokens).size).toBe(N);
    expect(new Set(doneTokens)).toEqual(new Set(ordered));

    // every booking COMPLETED exactly once, with both timestamps
    const bookings = await prisma.booking.findMany({ where: { id: { in: ids } } });
    expect(bookings).toHaveLength(N);
    for (const b of bookings) {
      expect(b.status).toBe(BookingStatus.COMPLETED);
      expect(b.consultationStartedAt).not.toBeNull();
      expect(b.consultationEndedAt).not.toBeNull();
      expect(b.consultationStartedAt!.getTime()).toBeLessThanOrEqual(
        b.consultationEndedAt!.getTime(),
      );
    }

    // queue fully drained
    expect(await queueService.size(session)).toBe(0);
  });
});
