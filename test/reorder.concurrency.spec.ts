import { ConfigService } from '@nestjs/config';
import { BookingStatus, BookingSource } from '@prisma/client';
import { RedisService } from '../src/common/redis/redis.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { QueueEventsService } from '../src/queue-engine/queue-events.service';

/**
 * Step 3.8-3.10 — skip / emergency-priority / reinsert, against REAL Redis +
 * Postgres. All three route through the same per-session advance lock. Includes
 * the required cross-operation race tests.
 */
describe('ConsultationService — skip / priority / reinsert (real Redis + Postgres)', () => {
  let redisService: RedisService;
  let prisma: PrismaService;
  let queueService: QueueService;
  let consult: ConsultationService;

  const CLINIC_ID = 'reorder-test-clinic';
  const DOCTOR_ID = 'reorder-test-doctor';
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

  let seq = 0;

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
      create: { id: CLINIC_ID, name: 'Reorder Test Clinic' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: {
        id: DOCTOR_ID,
        clinicId: CLINIC_ID,
        name: 'Dr Reorder',
        avgConsultMinutes: 8,
      },
      update: {},
    });
  });

  beforeEach(async () => {
    await reset();
  });

  afterAll(async () => {
    await reset();
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await prisma.onModuleDestroy();
    await redisService.onModuleDestroy();
  });

  async function reset(): Promise<void> {
    await queueService.clearSession(session);
    await prisma.booking.deleteMany({ where: { doctorId: DOCTOR_ID } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'ro-pt-' } } });
  }

  /** Create a BOOKED booking + patient. Returns bookingId. */
  async function makeBooking(source: TokenSource): Promise<string> {
    const patientId = `ro-pt-${seq++}`;
    await prisma.patient.create({
      data: { id: patientId, name: patientId, mobile: `7${Date.now()}${seq}` },
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

  async function enqueue(source: TokenSource): Promise<string> {
    const id = await makeBooking(source);
    await consult.enqueueBooking(source, session, id);
    return id;
  }

  async function statusOf(id: string): Promise<BookingStatus> {
    const b = await prisma.booking.findUniqueOrThrow({ where: { id } });
    return b.status;
  }

  // ── SKIP ───────────────────────────────────────────────
  it('skip ACTIVE: token goes to back, reverts to BOOKED, next promoted', async () => {
    const idA = await enqueue(TokenSource.APP); // A001 active
    const idB = await enqueue(TokenSource.WALK_IN); // W001
    const idC = await enqueue(TokenSource.VOICE); // A002

    const res = await consult.skip(session, 'A001');
    expect(res.wasActive).toBe(true);
    expect(res.newActiveToken).toBe('W001');

    expect(await queueService.list(session)).toEqual(['W001', 'A002', 'A001']);
    expect(await statusOf(idA)).toBe(BookingStatus.BOOKED); // skipped -> waiting
    const bA = await prisma.booking.findUniqueOrThrow({ where: { id: idA } });
    expect(bA.consultationStartedAt).toBeNull(); // un-stamped
    expect(await statusOf(idB)).toBe(BookingStatus.ACTIVE);
    expect(await statusOf(idC)).toBe(BookingStatus.BOOKED);
  });

  it('skip BOOKED mid-queue: moves to back, no promotion, front untouched', async () => {
    const idA = await enqueue(TokenSource.APP); // A001 active
    const idB = await enqueue(TokenSource.WALK_IN); // W001 (skip target)
    const idC = await enqueue(TokenSource.VOICE); // A002

    const res = await consult.skip(session, 'W001');
    expect(res.wasActive).toBe(false);
    expect(await queueService.list(session)).toEqual(['A001', 'A002', 'W001']);
    expect(await statusOf(idA)).toBe(BookingStatus.ACTIVE);
    expect(await statusOf(idB)).toBe(BookingStatus.BOOKED);
    expect(await statusOf(idC)).toBe(BookingStatus.BOOKED);
  });

  it('skip on a gone token rejects', async () => {
    await enqueue(TokenSource.APP);
    await consult.markDone(session); // A001 gone
    await expect(consult.skip(session, 'A001')).rejects.toThrow(
      /no longer in the queue/,
    );
  });

  // ── EMERGENCY PRIORITY ─────────────────────────────────
  it('priority insert lands just behind active, ahead of normal waiters', async () => {
    await enqueue(TokenSource.APP); // A001 active
    await enqueue(TokenSource.WALK_IN); // W001 waiting
    const idP = await makeBooking(TokenSource.WALK_IN);

    const res = await consult.priorityInsert(TokenSource.WALK_IN, session, idP);
    expect(res.isActive).toBe(false);

    const list = await queueService.list(session);
    expect(list[0]).toBe('A001'); // active stays
    expect(list[1]).toBe(res.token); // priority is first waiting
    expect(list[2]).toBe('W001'); // normal waiter pushed back
    expect(await statusOf(idP)).toBe(BookingStatus.BOOKED);
  });

  it('priority on empty queue becomes ACTIVE immediately', async () => {
    const idP = await makeBooking(TokenSource.WALK_IN);
    const res = await consult.priorityInsert(TokenSource.WALK_IN, session, idP);
    expect(res.isActive).toBe(true);
    expect(await statusOf(idP)).toBe(BookingStatus.ACTIVE);
    expect(await queueService.frontToken(session)).toBe(res.token);
  });

  it('LOCKED SEMANTIC: a newer priority jumps ahead of an earlier priority still waiting', async () => {
    await enqueue(TokenSource.APP); // A001 active
    const idP1 = await makeBooking(TokenSource.WALK_IN);
    const idP2 = await makeBooking(TokenSource.WALK_IN);

    const p1 = await consult.priorityInsert(TokenSource.WALK_IN, session, idP1);
    const p2 = await consult.priorityInsert(TokenSource.WALK_IN, session, idP2);

    const list = await queueService.list(session);
    // active, then NEWEST priority (p2), then earlier priority (p1)
    expect(list).toEqual(['A001', p2.token, p1.token]);
  });

  // ── REINSERT ───────────────────────────────────────────
  it('reinsert places a NO_SHOW patient after an anchor; NO_SHOW -> BOOKED', async () => {
    const idA = await enqueue(TokenSource.APP); // A001 active
    const idB = await enqueue(TokenSource.WALK_IN); // W001
    const idC = await enqueue(TokenSource.VOICE); // A002

    // B no-shows mid-queue
    await consult.markNoShow(session, 'W001');
    expect(await statusOf(idB)).toBe(BookingStatus.NO_SHOW);
    expect(await queueService.list(session)).toEqual(['A001', 'A002']);

    // reinsert W001 after A001
    const res = await consult.reinsert(session, 'W001', 'A001', idB);
    expect(res.token).toBe('W001');
    expect(await queueService.list(session)).toEqual(['A001', 'W001', 'A002']);
    expect(await statusOf(idB)).toBe(BookingStatus.BOOKED);

    void idA;
    void idC;
  });

  it('reinsert rejects when booking is not NO_SHOW', async () => {
    const idA = await enqueue(TokenSource.APP); // active, BOOKED->ACTIVE
    const idB = await enqueue(TokenSource.WALK_IN);
    await expect(
      consult.reinsert(session, 'X999', 'A001', idB),
    ).rejects.toThrow(/only valid from NO_SHOW/);
    void idA;
  });

  it('reinsert rejects when the anchor token is gone', async () => {
    const idA = await enqueue(TokenSource.APP);
    const idB = await enqueue(TokenSource.WALK_IN);
    await consult.markNoShow(session, 'W001'); // B -> NO_SHOW
    await consult.markDone(session); // A001 gone (anchor)
    await expect(
      consult.reinsert(session, 'W001', 'A001', idB),
    ).rejects.toThrow(/anchor token A001 is no longer/);
    void idA;
  });

  // ── RACE: DONE vs SKIP on same active token ────────────
  it('RACE: DONE and skip on the same active token — exactly one wins, consistent', async () => {
    const RUNS = 30;
    for (let r = 0; r < RUNS; r++) {
      await reset();
      const idA = await enqueue(TokenSource.APP); // A001 active
      const idB = await enqueue(TokenSource.WALK_IN); // W001

      const [done, skip] = await Promise.allSettled([
        consult.markDone(session, 'A001'),
        consult.skip(session, 'A001'),
      ]);

      const wins = [done, skip].filter((s) => s.status === 'fulfilled');
      // both CAN succeed in sequence? No: DONE removes A001; skip then finds it
      // GONE and rejects. OR skip first moves A001 to back + promotes W001, then
      // DONE(expected A001) sees front=W001 -> MISMATCH reject. Exactly one wins.
      expect(wins).toHaveLength(1);

      const sA = await statusOf(idA);
      if (done.status === 'fulfilled') {
        expect(sA).toBe(BookingStatus.COMPLETED);
      } else {
        // skip won: A001 moved to back, BOOKED again; W001 promoted
        expect(sA).toBe(BookingStatus.BOOKED);
        expect(await statusOf(idB)).toBe(BookingStatus.ACTIVE);
      }
    }
  });

  // ── RACE: two priority inserts on the same gap ─────────
  it('RACE: two priority inserts on the same score gap get distinct slots, newest ahead', async () => {
    const RUNS = 30;
    for (let r = 0; r < RUNS; r++) {
      await reset();
      await enqueue(TokenSource.APP); // A001 active
      const id1 = await makeBooking(TokenSource.WALK_IN);
      const id2 = await makeBooking(TokenSource.WALK_IN);

      const [r1, r2] = await Promise.all([
        consult.priorityInsert(TokenSource.WALK_IN, session, id1),
        consult.priorityInsert(TokenSource.WALK_IN, session, id2),
      ]);

      // distinct scores, both present, no overwrite/collision
      expect(r1.score).not.toBe(r2.score);
      const list = await queueService.list(session);
      expect(list[0]).toBe('A001');
      expect(list).toContain(r1.token);
      expect(list).toContain(r2.token);
      expect(new Set(list).size).toBe(list.length); // no duplicates
      // the one with the smaller score is the first waiter
      const firstWaiter = r1.score < r2.score ? r1.token : r2.token;
      expect(list[1]).toBe(firstWaiter);
    }
  });

  // ── RACE: reinsert vs DONE on the anchor (current front) ───
  it('RACE: reinsert(after front) vs DONE(front) — consistent either way', async () => {
    const RUNS = 30;
    for (let r = 0; r < RUNS; r++) {
      await reset();
      const idA = await enqueue(TokenSource.APP); // A001 active (anchor)
      const idB = await enqueue(TokenSource.WALK_IN); // W001
      await consult.markNoShow(session, 'W001'); // B -> NO_SHOW, out of queue
      expect(await queueService.list(session)).toEqual(['A001']);

      const [reins, done] = await Promise.allSettled([
        consult.reinsert(session, 'W001', 'A001', idB),
        consult.markDone(session, 'A001'),
      ]);

      // DONE on a lone front always succeeds (it pops A001 regardless of order)
      expect(done.status).toBe('fulfilled');
      expect(await statusOf(idA)).toBe(BookingStatus.COMPLETED);

      const inQueue = (await queueService.list(session)).includes('W001');
      if (reins.status === 'fulfilled') {
        // reinsert ran before DONE: W001 was re-added, then promoted by DONE
        expect(inQueue).toBe(true);
        expect([BookingStatus.BOOKED, BookingStatus.ACTIVE]).toContain(
          await statusOf(idB),
        );
      } else {
        // DONE removed the anchor first -> reinsert rejected, W001 stays NO_SHOW
        expect(inQueue).toBe(false);
        expect(await statusOf(idB)).toBe(BookingStatus.NO_SHOW);
      }
    }
  });
});
