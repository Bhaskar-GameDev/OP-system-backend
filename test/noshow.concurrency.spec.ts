import { ConfigService } from '@nestjs/config';
import { BookingStatus, BookingSource } from '@prisma/client';
import { RedisService } from '../src/common/redis/redis.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { QueueEventsService } from '../src/queue-engine/queue-events.service';

/**
 * Step 3.7 — no-show, against REAL Redis + Postgres.
 *
 * Covers ACTIVE vs BOOKED removal, stale (GONE) rejection, and — the key case —
 * a no-show and a DONE racing for the same active token: exactly one wins, the
 * other rejects, and started_at/ended_at never end up inconsistent.
 */
describe('ConsultationService — no-show (real Redis + Postgres)', () => {
  let redisService: RedisService;
  let prisma: PrismaService;
  let queueService: QueueService;
  let consult: ConsultationService;

  const CLINIC_ID = 'noshow-test-clinic';
  const DOCTOR_ID = 'noshow-test-doctor';
  const session: SessionKey = {
    doctorId: DOCTOR_ID,
    sessionDate: '2026-06-19',
    sessionType: 'MORNING',
  };

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
      create: { id: CLINIC_ID, name: 'No-show Test Clinic' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: {
        id: DOCTOR_ID,
        clinicId: CLINIC_ID,
        name: 'Dr NoShow',
        avgConsultMinutes: 6,
      },
      update: {},
    });
  });

  beforeEach(async () => {
    await queueService.clearSession(session);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'ns-pt-' } } });
  });

  afterAll(async () => {
    await queueService.clearSession(session);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'ns-pt-' } } });
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await prisma.onModuleDestroy();
    await redisService.onModuleDestroy();
  });

  async function enqueue(i: number, source: TokenSource): Promise<string> {
    const patientId = `ns-pt-${i}`;
    await prisma.patient.create({
      data: { id: patientId, name: `P${i}`, mobile: `8${Date.now()}${i}` },
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
    await consult.enqueueBooking(source, session, b.id);
    return b.id;
  }

  it('no-show on ACTIVE: NO_SHOW, ended_at null, next promoted ACTIVE', async () => {
    const id0 = await enqueue(0, TokenSource.APP); // A001 active
    const id1 = await enqueue(1, TokenSource.WALK_IN); // W001 booked

    const res = await consult.markNoShow(session, 'A001');
    expect(res.wasActive).toBe(true);
    expect(res.noShowBookingId).toBe(id0);
    expect(res.newActiveToken).toBe('W001');

    const b0 = await prisma.booking.findUniqueOrThrow({ where: { id: id0 } });
    const b1 = await prisma.booking.findUniqueOrThrow({ where: { id: id1 } });
    expect(b0.status).toBe(BookingStatus.NO_SHOW);
    expect(b0.consultationEndedAt).toBeNull();
    expect(b1.status).toBe(BookingStatus.ACTIVE);
    expect(b1.consultationStartedAt).not.toBeNull();
    expect(await queueService.frontToken(session)).toBe('W001');
  });

  it('no-show on BOOKED mid-queue: ZREM, NO_SHOW, no promotion', async () => {
    const id0 = await enqueue(0, TokenSource.APP); // A001 active
    const id1 = await enqueue(1, TokenSource.WALK_IN); // W001 booked (target)
    const id2 = await enqueue(2, TokenSource.VOICE); // A002 booked

    const res = await consult.markNoShow(session, 'W001');
    expect(res.wasActive).toBe(false);
    expect(res.newActiveToken).toBeNull();

    const b0 = await prisma.booking.findUniqueOrThrow({ where: { id: id0 } });
    const b1 = await prisma.booking.findUniqueOrThrow({ where: { id: id1 } });
    const b2 = await prisma.booking.findUniqueOrThrow({ where: { id: id2 } });
    expect(b0.status).toBe(BookingStatus.ACTIVE); // front untouched
    expect(b1.status).toBe(BookingStatus.NO_SHOW);
    expect(b2.status).toBe(BookingStatus.BOOKED); // shifted up but not promoted

    // A002 is now rank 1 (one ahead: A001)
    expect(await queueService.list(session)).toEqual(['A001', 'A002']);
  });

  it('no-show on a token already gone rejects cleanly', async () => {
    const id0 = await enqueue(0, TokenSource.APP);
    await consult.markDone(session); // A001 completed + removed

    await expect(consult.markNoShow(session, 'A001')).rejects.toThrow(
      /no longer in the queue/,
    );
    const b0 = await prisma.booking.findUniqueOrThrow({ where: { id: id0 } });
    expect(b0.status).toBe(BookingStatus.COMPLETED); // untouched by the stale no-show
  });

  it('no-show vs DONE on the SAME active token: exactly one wins, state consistent', async () => {
    const RUNS = 30;
    for (let r = 0; r < RUNS; r++) {
      await queueService.clearSession(session);
      await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
      await prisma.patient.deleteMany({ where: { id: { startsWith: 'ns-pt-' } } });

      const idA = await enqueue(0, TokenSource.APP); // A001 active (target)
      const idB = await enqueue(1, TokenSource.WALK_IN); // W001 next

      // both target the SAME active token, fired together
      const [done, noshow] = await Promise.allSettled([
        consult.markDone(session, 'A001'),
        consult.markNoShow(session, 'A001'),
      ]);

      const wins = [done, noshow].filter((s) => s.status === 'fulfilled');
      const losses = [done, noshow].filter((s) => s.status === 'rejected');
      expect(wins).toHaveLength(1);
      expect(losses).toHaveLength(1);

      const bA = await prisma.booking.findUniqueOrThrow({ where: { id: idA } });
      const bB = await prisma.booking.findUniqueOrThrow({ where: { id: idB } });

      // target is EITHER completed OR no-show — never both, never inconsistent
      if (bA.status === BookingStatus.COMPLETED) {
        expect(bA.consultationStartedAt).not.toBeNull();
        expect(bA.consultationEndedAt).not.toBeNull();
      } else {
        expect(bA.status).toBe(BookingStatus.NO_SHOW);
        expect(bA.consultationEndedAt).toBeNull(); // no-show never stamps ended_at
      }

      // whichever op won, the next patient was promoted exactly once
      expect(bB.status).toBe(BookingStatus.ACTIVE);
      expect(bB.consultationStartedAt).not.toBeNull();
      expect(bB.consultationEndedAt).toBeNull();
      expect(await queueService.frontToken(session)).toBe('W001');
    }
  });
});
