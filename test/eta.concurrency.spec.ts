import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/common/redis/redis.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { EtaService } from '../src/queue-engine/eta.service';

/**
 * Step 3.5 — live ETA, proven against REAL Redis + REAL Postgres (no mocks).
 *
 * ETA = patientsAhead × doctor.avg_consult_minutes, computed live. The test
 * asserts this exact identity across a mixed A/W/VOICE queue, and again AFTER
 * a DONE press removes the front patient and shifts everyone up — with no
 * recalculation step, because ZRANK is already current.
 */
describe('EtaService — live ETA (real Redis + Postgres)', () => {
  let redisService: RedisService;
  let prisma: PrismaService;
  let queueService: QueueService;
  let etaService: EtaService;

  const AVG = 7; // doctor.avg_consult_minutes for this test
  const CLINIC_ID = 'eta-test-clinic';
  const DOCTOR_ID = 'eta-test-doctor';

  const session: SessionKey = {
    doctorId: DOCTOR_ID,
    sessionDate: '2026-06-19',
    sessionType: 'MORNING',
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
    etaService = new EtaService(prisma, queueService);

    // seed clinic + doctor with a known avg_consult_minutes
    await prisma.clinic.upsert({
      where: { id: CLINIC_ID },
      create: { id: CLINIC_ID, name: 'ETA Test Clinic' },
      update: {},
    });
    await prisma.doctor.upsert({
      where: { id: DOCTOR_ID },
      create: {
        id: DOCTOR_ID,
        clinicId: CLINIC_ID,
        name: 'Dr ETA',
        avgConsultMinutes: AVG,
      },
      update: { avgConsultMinutes: AVG },
    });
  });

  beforeEach(async () => {
    await queueService.clearSession(session);
  });

  afterAll(async () => {
    await queueService.clearSession(session);
    await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
    await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
    await prisma.onModuleDestroy();
    await redisService.onModuleDestroy();
  });

  it('ETA == patientsAhead × avg across a mixed A/W/VOICE queue', async () => {
    // arrival: APP, WALK_IN, VOICE, APP, WALK_IN
    const sources: TokenSource[] = [
      TokenSource.APP,
      TokenSource.WALK_IN,
      TokenSource.VOICE,
      TokenSource.APP,
      TokenSource.WALK_IN,
    ];
    for (const s of sources) await queueService.enqueue(s, session);

    const etas = await etaService.etaForQueue(session);

    // identity holds for every slot
    etas.forEach((e, i) => {
      expect(e.patientsAhead).toBe(i);
      expect(e.avgConsultMinutes).toBe(AVG);
      expect(e.etaMinutes).toBe(i * AVG);
    });
    // concrete: front waits 0, last of 5 waits 4*7=28
    expect(etas.map((e) => e.etaMinutes)).toEqual([0, 7, 14, 21, 28]);

    // per-token path agrees with the batch path
    for (const e of etas) {
      const single = await etaService.etaFor(e.tokenNumber, session);
      expect(single?.etaMinutes).toBe(e.etaMinutes);
    }
  });

  it('after a DONE press, ETAs shift with positions — no recalc needed', async () => {
    for (const s of [
      TokenSource.APP,
      TokenSource.WALK_IN,
      TokenSource.VOICE,
      TokenSource.APP,
    ]) {
      await queueService.enqueue(s, session);
    }

    const before = await queueService.list(session); // [A001,W001,A002,A003]
    const front = before[0];

    const survivor = before[1];
    const survivorBefore = await etaService.etaFor(survivor, session);
    expect(survivorBefore?.etaMinutes).toBe(1 * AVG); // 1 ahead

    // DONE: front patient consulted & leaves the queue (full DONE flow = Step 3.6)
    await queueService.removeToken(front, session);

    // everyone shifted up by one — ETA recomputed live off the new ZRANK
    const after = await etaService.etaForQueue(session);
    expect(after.map((e) => e.tokenNumber)).toEqual(before.slice(1));
    after.forEach((e, i) => {
      expect(e.etaMinutes).toBe(i * AVG);
    });

    // the survivor that was 2nd is now front: ETA 1*AVG -> 0
    const survivorAfter = await etaService.etaFor(survivor, session);
    expect(survivorAfter?.etaMinutes).toBe(0);
  });

  it('100 concurrent mixed enqueues: every ETA == position-index × avg', async () => {
    const N = 100;
    const calls = Array.from({ length: N }, (_, i) =>
      queueService.enqueue(
        i % 3 === 0
          ? TokenSource.WALK_IN
          : i % 3 === 1
            ? TokenSource.VOICE
            : TokenSource.APP,
        session,
      ),
    );
    await Promise.all(calls);

    const etas = await etaService.etaForQueue(session);
    expect(etas).toHaveLength(N);
    etas.forEach((e, i) => {
      expect(e.etaMinutes).toBe(i * AVG);
      expect(e.position).toBe(i + 1);
    });
  });
});
