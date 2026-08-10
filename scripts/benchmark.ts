/**
 * Patient Flow OS — performance benchmark.
 *
 * The audit's performance section scored 5/10 with the note that NO measurements
 * had ever been taken: every scalability claim in the codebase was an argument
 * from inspection. This script exists so the optimisation work that follows is
 * driven by numbers, and so a regression is detectable later.
 *
 * Run against the local stack (Postgres :5433 + Redis :6379):
 *
 *   npm run bench
 *   BENCH_DEPTHS=30,60,120 BENCH_ITERATIONS=200 npm run bench
 *
 * It writes nothing to the production database — it creates its own clinic,
 * doctor and session, and deletes them afterwards.
 *
 * WHAT IS MEASURED, AND WHY EACH ONE
 *
 *   1. Queue mutation latency at depth — the audit named 30–60 patients per
 *      doctor as the realistic range. This is the operation a receptionist
 *      presses hundreds of times a day.
 *   2. Broadcast fan-out — every queue mutation triggers one. Cost here is
 *      multiplied by the mutation rate across every concurrently active doctor.
 *   3. Redis round trips per broadcast — the specific finding was an N+1: one
 *      lookup per waiting patient. Counted directly rather than inferred from
 *      timing, because a fast local Redis hides it.
 *   4. Login throughput — bcrypt cost 12 is deliberately slow, which makes the
 *      login route both a latency question and a DoS surface.
 *
 * Numbers from a developer laptop are not production numbers. They are a
 * BASELINE for comparing before/after on the same machine.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { RedisService } from '../src/common/redis/redis.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { EtaService } from '../src/queue-engine/eta.service';
import { PasswordService } from '../src/auth/password.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';

const DEPTHS = (process.env.BENCH_DEPTHS ?? '30,60')
  .split(',')
  .map((d) => Number(d.trim()))
  .filter((d) => d > 0);
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 100);

const CLINIC_ID = 'bench-clinic';
const DOCTOR_ID = 'bench-doctor';

interface Stats extends Record<string, number> {
  n: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function stats(samples: number[]): Stats {
  const sorted = [...samples].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    meanMs: round(sorted.reduce((a, b) => a + b, 0) / sorted.length),
    p50Ms: round(at(0.5)),
    p95Ms: round(at(0.95)),
    maxMs: round(sorted[sorted.length - 1]),
  };
}

const round = (n: number): number => Math.round(n * 1000) / 1000;

async function timed(fn: () => Promise<unknown>): Promise<number> {
  const start = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function table(title: string, rows: Record<string, unknown>[]): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
  console.table(rows);
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const prisma = app.get(PrismaService);
  const redisService = app.get(RedisService);
  const queue = app.get(QueueService);
  const eta = app.get(EtaService);
  const passwords = app.get(PasswordService);

  const session: SessionKey = {
    doctorId: DOCTOR_ID,
    sessionDate: '2030-01-01', // far future: cannot collide with real data
    sessionType: 'MORNING',
  };

  console.log(`Patient Flow OS benchmark — depths ${DEPTHS.join(', ')}, ${ITERATIONS} iterations`);
  console.log(`node ${process.version} · ${new Date().toISOString()}`);

  // ── fixtures ───────────────────────────────────────────────────────────
  const hospital = await prisma.hospital.findFirstOrThrow({ select: { id: true } });
  await prisma.clinic.upsert({
    where: { id: CLINIC_ID },
    create: { id: CLINIC_ID, name: 'Benchmark Clinic', hospitalId: hospital.id },
    update: {},
  });
  await prisma.doctor.upsert({
    where: { id: DOCTOR_ID },
    create: {
      id: DOCTOR_ID,
      clinicId: CLINIC_ID,
      name: 'Dr Benchmark',
      avgConsultMinutes: 8,
    },
    update: {},
  });

  const clearQueue = async (): Promise<void> => {
    await queue.clearSession(session);
    const keys = await redisService.redis.keys('pfos:*bench-doctor*');
    if (keys.length > 0) await redisService.redis.del(...keys);
  };

  // ── 1. queue mutation latency at depth ─────────────────────────────────
  const mutationRows: Record<string, unknown>[] = [];
  for (const depth of DEPTHS) {
    await clearQueue();
    for (let i = 0; i < depth; i++) {
      await queue.enqueue(TokenSource.WALK_IN, session, `bench-booking-${i}`);
    }

    // Enqueue at depth: what a walk-in costs when the queue is already full.
    const enqueueSamples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      let token = '';
      enqueueSamples.push(
        await timed(async () => {
          token = (await queue.enqueue(TokenSource.WALK_IN, session, `bench-churn-${i}`)).tokenNumber;
        }),
      );
      // Remove what we just added so the depth stays constant: without this,
      // later samples measure a deeper queue than earlier ones and the mean
      // describes no particular depth at all.
      await queue.removeToken(token, session);
      await queue.unmapToken(token, session);
    }

    // The read behind every queue screen and every broadcast.
    const readSamples: number[] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      readSamples.push(await timed(() => eta.etaForQueue(session)));
    }

    mutationRows.push({ depth, op: 'enqueue', ...stats(enqueueSamples) });
    mutationRows.push({ depth, op: 'etaForQueue', ...stats(readSamples) });
  }
  table('Queue operations by depth', mutationRows);

  // ── 2 & 3. broadcast cost and its Redis round trips ────────────────────
  // Counted by wrapping the client: timing alone hides an N+1 on a local Redis
  // where a round trip is ~0.1ms, and it is the round-trip COUNT that scales
  // with queue length across every connected clinic.
  const broadcastRows: Record<string, unknown>[] = [];
  for (const depth of DEPTHS) {
    await clearQueue();
    for (let i = 0; i < depth; i++) {
      await queue.enqueue(TokenSource.WALK_IN, session, `bench-booking-${i}`);
    }

    const redis = redisService.redis;
    let calls = 0;
    const originalHget = redis.hget.bind(redis);
    const originalHgetall = redis.hgetall.bind(redis);
    (redis as unknown as { hget: unknown }).hget = (...args: unknown[]) => {
      calls++;
      return (originalHget as (...a: unknown[]) => unknown)(...args);
    };
    (redis as unknown as { hgetall: unknown }).hgetall = (...args: unknown[]) => {
      calls++;
      return (originalHgetall as (...a: unknown[]) => unknown)(...args);
    };

    // Both patterns are measured every run: the batched one is what broadcast()
    // does now, and the per-entry one stays as the comparison that shows why —
    // and as the guard that notices if the N+1 ever comes back.
    const perEntrySamples: number[] = [];
    let perEntryLookups = 0;
    for (let i = 0; i < Math.min(ITERATIONS, 50); i++) {
      calls = 0;
      perEntrySamples.push(
        await timed(async () => {
          const entries = await eta.etaForQueue(session);
          await Promise.all(
            entries.map((entry) => queue.bookingIdFor(entry.tokenNumber, session)),
          );
        }),
      );
      perEntryLookups = calls;
    }

    const samples: number[] = [];
    let roundTrips = 0;
    for (let i = 0; i < Math.min(ITERATIONS, 50); i++) {
      calls = 0;
      samples.push(
        await timed(async () => {
          // The exact work broadcast() does per mutation, as shipped.
          await eta.etaForQueue(session);
          await queue.bookingIdsFor(session);
        }),
      );
      roundTrips = calls;
    }

    (redis as unknown as { hget: unknown }).hget = originalHget;
    (redis as unknown as { hgetall: unknown }).hgetall = originalHgetall;

    broadcastRows.push({
      depth,
      pattern: 'per-entry (old)',
      lookups: perEntryLookups,
      ...stats(perEntrySamples),
    });
    broadcastRows.push({
      depth,
      pattern: 'batched (current)',
      lookups: roundTrips,
      ...stats(samples),
    });
  }
  table('Broadcast fan-out (per queue mutation)', broadcastRows);

  // ── 4. login cost ──────────────────────────────────────────────────────
  // bcrypt cost 12 is a deliberate choice: it is what makes a stolen password
  // hash expensive to crack. The same property makes the login route a CPU
  // amplifier, so the number matters for capacity AND for abuse.
  const hash = await passwords.hash('benchmark-password');
  const compareSamples: number[] = [];
  for (let i = 0; i < Math.min(ITERATIONS, 25); i++) {
    compareSamples.push(await timed(() => passwords.compare('benchmark-password', hash)));
  }
  const compare = stats(compareSamples);
  table('Password verification (bcrypt cost 12)', [
    {
      ...compare,
      sequentialLoginsPerSecond: round(1000 / compare.meanMs),
      note: 'per core; concurrent logins contend for the same CPU',
    },
  ]);

  // ── 5. database round trip ─────────────────────────────────────────────
  const dbSamples: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    dbSamples.push(await timed(() => prisma.$queryRaw`SELECT 1`));
  }
  table('Postgres round trip (SELECT 1)', [stats(dbSamples)]);

  // ── cleanup ────────────────────────────────────────────────────────────
  await clearQueue();
  await prisma.doctor.deleteMany({ where: { id: DOCTOR_ID } });
  await prisma.clinic.deleteMany({ where: { id: CLINIC_ID } });
  await app.close();

  console.log('\nBaseline recorded. Compare before/after on the SAME machine —');
  console.log('absolute numbers from a laptop are not production numbers.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
