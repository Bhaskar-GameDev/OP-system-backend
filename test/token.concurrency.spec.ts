import { ConfigService } from '@nestjs/config';
import { RedisService } from '../src/common/redis/redis.service';
import {
  TokenService,
  TokenSource,
  SessionKey,
  IssuedToken,
} from '../src/queue-engine/token.service';

/**
 * THE most important test in the codebase.
 *
 * Proves token issuance is collision-free and gap-free under heavy concurrent
 * load — the exact scenario that breaks naive read-modify-write counters:
 * patient-app bookings, reception walk-ins, and (later) doctor DONE all hit
 * the same doctor/session within the same instant.
 *
 * Requires a live Redis (docker compose up). It uses the REAL RedisService +
 * real INCR — a mock would defeat the purpose, since the property under test
 * is Redis's atomicity, not our arithmetic.
 */
describe('TokenService — concurrency (real Redis)', () => {
  let redisService: RedisService;
  let tokenService: TokenService;

  const session: SessionKey = {
    doctorId: 'concurrency-test-doctor',
    sessionDate: '2026-06-19',
    sessionType: 'MORNING',
  };

  beforeAll(async () => {
    // Real RedisService driven by env (.env via docker-compose defaults).
    const config = new ConfigService({
      REDIS_HOST: process.env.REDIS_HOST ?? 'localhost',
      REDIS_PORT: Number(process.env.REDIS_PORT ?? 6379),
      REDIS_PASSWORD: process.env.REDIS_PASSWORD ?? '',
    });
    redisService = new RedisService(config);
    redisService.onModuleInit();
    tokenService = new TokenService(redisService);

    // Clean slate so sequences start at 1.
    await tokenService.resetCounter(TokenSource.APP, session);
    await tokenService.resetCounter(TokenSource.WALK_IN, session);
  });

  afterAll(async () => {
    await tokenService.resetCounter(TokenSource.APP, session);
    await tokenService.resetCounter(TokenSource.WALK_IN, session);
    await redisService.onModuleDestroy();
  });

  it('fires 60 concurrent app-token requests: zero duplicates, zero gaps', async () => {
    const N = 60;
    const results = await Promise.all(
      Array.from({ length: N }, () => tokenService.issueAppToken(session)),
    );

    assertContiguous(results, 'A', N);
  });

  it('mixes 100 concurrent app + walk-in requests on the same session', async () => {
    await tokenService.resetCounter(TokenSource.APP, session);
    await tokenService.resetCounter(TokenSource.WALK_IN, session);

    const APP = 55;
    const WALK = 45;

    // Interleave the two sources, all fired at once.
    const calls: Promise<IssuedToken>[] = [];
    for (let i = 0; i < APP; i++) calls.push(tokenService.issueAppToken(session));
    for (let i = 0; i < WALK; i++) calls.push(tokenService.issueWalkInToken(session));

    const results = await Promise.all(shuffle(calls));

    const appTokens = results.filter((r) => r.source === TokenSource.APP);
    const walkTokens = results.filter((r) => r.source === TokenSource.WALK_IN);

    expect(appTokens).toHaveLength(APP);
    expect(walkTokens).toHaveLength(WALK);

    // Independent counters, each contiguous, prefixes never cross.
    assertContiguous(appTokens, 'A', APP);
    assertContiguous(walkTokens, 'W', WALK);
  });

  it('survives repeated bursts without drift', async () => {
    await tokenService.resetCounter(TokenSource.APP, session);

    let total = 0;
    for (let burst = 0; burst < 5; burst++) {
      const size = 25;
      await Promise.all(
        Array.from({ length: size }, () => tokenService.issueAppToken(session)),
      );
      total += size;
    }

    const counter = await tokenService.peekCounter(TokenSource.APP, session);
    expect(counter).toBe(total); // 125 — no lost increments across bursts
  });
});

/** Assert tokens form an exact contiguous set 1..N with the given prefix. */
function assertContiguous(tokens: IssuedToken[], prefix: string, n: number): void {
  const seqs = tokens.map((t) => t.sequence).sort((a, b) => a - b);

  // unique
  expect(new Set(seqs).size).toBe(n);

  // contiguous 1..N — proves no skipped/duplicate numbers
  for (let i = 0; i < n; i++) {
    expect(seqs[i]).toBe(i + 1);
  }

  // token strings unique and correctly prefixed/padded
  const strs = tokens.map((t) => t.tokenNumber);
  expect(new Set(strs).size).toBe(n);
  for (const t of tokens) {
    expect(t.tokenNumber.startsWith(prefix)).toBe(true);
    expect(t.tokenNumber).toBe(
      `${prefix}${String(t.sequence).padStart(3, '0')}`,
    );
  }
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
