import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/common/redis/redis.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import { QueueService, QueueEntry } from '../src/queue-engine/queue.service';

/**
 * Step 3.2 — unified queue ordering, proven against REAL Redis (no mocks).
 *
 * Property under test: A and W tokens merge into ONE ordered queue by a single
 * shared arrival sequence, NOT by per-prefix counters. A walk-in that arrives
 * after an app booking must sort after it, even though it carries a separate
 * (W) token number.
 */
describe('QueueService — unified ordering (real Redis)', () => {
  let redisService: RedisService;
  let queueService: QueueService;

  const session: SessionKey = {
    doctorId: 'ordering-test-doctor',
    sessionDate: '2026-06-19',
    sessionType: 'MORNING',
  };

  beforeAll(() => {
    const config = new ConfigService({
      REDIS_HOST: process.env.REDIS_HOST ?? 'localhost',
      REDIS_PORT: Number(process.env.REDIS_PORT ?? 6379),
      REDIS_PASSWORD: process.env.REDIS_PASSWORD ?? '',
    });
    redisService = new RedisService(config);
    redisService.onModuleInit();
    queueService = new QueueService(redisService);
  });

  beforeEach(async () => {
    await queueService.clearSession(session);
  });

  afterAll(async () => {
    await queueService.clearSession(session);
    await redisService.onModuleDestroy();
  });

  it('interleaved A/W (sequential) reflects arrival order, not per-prefix order', async () => {
    // Arrive: App, Walk, App, Walk, App  ->  A001 W001 A002 W002 A003
    const order: TokenSource[] = [
      TokenSource.APP,
      TokenSource.WALK_IN,
      TokenSource.APP,
      TokenSource.WALK_IN,
      TokenSource.APP,
    ];
    const issued: QueueEntry[] = [];
    for (const src of order) {
      issued.push(await queueService.enqueue(src, session));
    }

    const queue = await queueService.list(session);

    // merged queue == true arrival order
    expect(queue).toEqual(['A001', 'W001', 'A002', 'W002', 'A003']);

    // explicitly NOT per-prefix grouped (the naive-bug shape)
    expect(queue).not.toEqual(['A001', 'A002', 'A003', 'W001', 'W002']);

    // arrival scores are the single shared monotonic sequence 1..5
    expect(issued.map((e) => e.arrivalScore)).toEqual([1, 2, 3, 4, 5]);
    // token numbers came from independent per-prefix counters
    expect(issued.map((e) => e.tokenNumber)).toEqual([
      'A001',
      'W001',
      'A002',
      'W002',
      'A003',
    ]);
  });

  it('walk-in arriving after an app booking sorts AFTER it', async () => {
    const app = await queueService.enqueue(TokenSource.APP, session); // 9:00
    const walk = await queueService.enqueue(TokenSource.WALK_IN, session); // 9:02

    expect(walk.arrivalScore).toBeGreaterThan(app.arrivalScore);

    const appPos = await queueService.positionOf(app.tokenNumber, session);
    const walkPos = await queueService.positionOf(walk.tokenNumber, session);
    expect(appPos?.position).toBe(1);
    expect(walkPos?.position).toBe(2);
    expect(walkPos?.patientsAhead).toBe(1);
  });

  it('100 concurrent mixed enqueues: shared score unique+contiguous, no lost placements', async () => {
    const N = 100;
    // randomly mix sources, all fired at once
    const calls = Array.from({ length: N }, (_, i) => {
      const src =
        i % 3 === 0
          ? TokenSource.WALK_IN
          : i % 3 === 1
            ? TokenSource.VOICE // shares A counter + A prefix
            : TokenSource.APP;
      return queueService.enqueue(src, session);
    });

    const results = await Promise.all(shuffle(calls));

    // every placement landed
    expect(await queueService.size(session)).toBe(N);

    // shared arrival scores: unique and exactly 1..N (no dup, no gap)
    const scores = results.map((r) => r.arrivalScore).sort((a, b) => a - b);
    expect(new Set(scores).size).toBe(N);
    for (let i = 0; i < N; i++) expect(scores[i]).toBe(i + 1);

    // token members unique
    const tokens = results.map((r) => r.tokenNumber);
    expect(new Set(tokens).size).toBe(N);

    // queue rank of each token === its arrivalScore - 1 (order driven by shared score)
    for (const r of results) {
      const pos = await queueService.positionOf(r.tokenNumber, session);
      expect(pos?.position).toBe(r.arrivalScore);
    }

    // full queue is strictly score-ordered
    const withScores = await queueService.listWithScores(session);
    for (let i = 1; i < withScores.length; i++) {
      expect(withScores[i].arrivalScore).toBeGreaterThan(
        withScores[i - 1].arrivalScore,
      );
    }
  });
});

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
