import { performance } from 'node:perf_hooks';
import { ConfigService } from '@nestjs/config';
import { BookingStatus, BookingSource, Prisma } from '@prisma/client';
import { RedisService } from '../src/common/redis/redis.service';
import { PrismaService } from '../src/common/prisma/prisma.service';
import { SessionKey, TokenSource } from '../src/queue-engine/token.service';
import { QueueService } from '../src/queue-engine/queue.service';
import { ConsultationService } from '../src/queue-engine/consultation.service';
import { QueueEventsService } from '../src/queue-engine/queue-events.service';

/**
 * Queue Engine LOAD TEST — many sessions under concurrent load at once.
 *
 * Not one doctor in isolation: CLINICS x DOCTORS_PER_CLINIC live sessions, each
 * taking concurrent enqueues, then a simultaneous storm of DONE / no-show /
 * skip / priority-insert across ALL sessions at the same time. Proves:
 *   - per-session advance lock isolates sessions (Clinic A's load cannot corrupt
 *     Clinic B's queue),
 *   - zero correctness regressions under load: no duplicate tokens, no lost
 *     placements, no rank corruption, <=1 ACTIVE per session,
 * and reports throughput + latency percentiles.
 */
describe('Queue Engine — multi-session load test (real Redis + Postgres)', () => {
  let redisService: RedisService;
  let prisma: PrismaService;
  let queue: QueueService;
  let consult: ConsultationService;

  // Load shape.
  const CLINICS = 5;
  const DOCTORS_PER_CLINIC = 4; // -> 20 concurrent sessions
  const PER_SESSION = 30; // initial bookings enqueued per session
  const PRIORITY_PER_SESSION = 4; // emergency inserts per session during storm

  const SESSION_DATE = '2026-06-21';
  type Sess = { idx: number; clinicId: string; doctorId: string; key: SessionKey };
  const sessions: Sess[] = [];

  const toBookingSource: Record<TokenSource, BookingSource> = {
    [TokenSource.APP]: BookingSource.APP,
    [TokenSource.WALK_IN]: BookingSource.WALK_IN,
    [TokenSource.VOICE]: BookingSource.VOICE,
  };
  const SRC_ROTATION: TokenSource[] = [TokenSource.APP, TokenSource.WALK_IN, TokenSource.VOICE];

  let mobileSeq = 6_000_000_000;

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
    queue = new QueueService(redisService);
    consult = new ConsultationService(prisma, queue, redisService, new QueueEventsService());

    let idx = 0;
    for (let c = 0; c < CLINICS; c++) {
      const clinicId = `lt-clinic-${c}`;
      await prisma.clinic.upsert({
        where: { id: clinicId },
        create: { id: clinicId, name: `LT Clinic ${c}` },
        update: {},
      });
      for (let d = 0; d < DOCTORS_PER_CLINIC; d++) {
        const doctorId = `lt-doc-${c}-${d}`;
        await prisma.doctor.upsert({
          where: { id: doctorId },
          create: { id: doctorId, clinicId, name: `Dr ${c}-${d}`, avgConsultMinutes: 6 },
          update: {},
        });
        sessions.push({
          idx: idx++,
          clinicId,
          doctorId,
          key: { doctorId, sessionDate: SESSION_DATE, sessionType: 'MORNING' },
        });
      }
    }

    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.doctor.deleteMany({ where: { id: { startsWith: 'lt-doc-' } } });
    await prisma.clinic.deleteMany({ where: { id: { startsWith: 'lt-clinic-' } } });
    await prisma.onModuleDestroy();
    await redisService.onModuleDestroy();
  });

  async function cleanup(): Promise<void> {
    await Promise.all(sessions.map((s) => queue.clearSession(s.key)));
    await prisma.booking.deleteMany({ where: { doctorId: { startsWith: 'lt-doc-' } } });
    await prisma.patient.deleteMany({ where: { id: { startsWith: 'lt-pt-' } } });
  }

  // ── helpers ──────────────────────────────────────────────
  function pct(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[i];
  }
  async function timed(fn: () => Promise<unknown>): Promise<{ ok: boolean; ms: number }> {
    const t0 = performance.now();
    try {
      await fn();
      return { ok: true, ms: performance.now() - t0 };
    } catch {
      return { ok: false, ms: performance.now() - t0 };
    }
  }

  it('handles concurrent multi-session load with zero correctness regressions', async () => {
    // ── seed: bookings for every session, in bulk ──
    const patients: Prisma.PatientCreateManyInput[] = [];
    const bookings: Prisma.BookingCreateManyInput[] = [];
    const enqueuePlan: { s: Sess; bookingId: string; source: TokenSource }[] = [];
    const priorityPlan: { s: Sess; bookingId: string }[] = [];

    for (const s of sessions) {
      for (let i = 0; i < PER_SESSION; i++) {
        const patientId = `lt-pt-${s.idx}-${i}`;
        const bookingId = `lt-bk-${s.idx}-${i}`;
        const source = SRC_ROTATION[i % SRC_ROTATION.length];
        patients.push({ id: patientId, name: patientId, mobile: String(mobileSeq++) });
        bookings.push({
          id: bookingId,
          patientId,
          doctorId: s.doctorId,
          source: toBookingSource[source],
          sessionDate: new Date(SESSION_DATE),
          sessionType: 'MORNING',
          status: BookingStatus.BOOKED,
        });
        enqueuePlan.push({ s, bookingId, source });
      }
      for (let j = 0; j < PRIORITY_PER_SESSION; j++) {
        const patientId = `lt-pt-${s.idx}-pr-${j}`;
        const bookingId = `lt-bk-${s.idx}-pr-${j}`;
        patients.push({ id: patientId, name: patientId, mobile: String(mobileSeq++) });
        bookings.push({
          id: bookingId,
          patientId,
          doctorId: s.doctorId,
          source: BookingSource.WALK_IN,
          sessionDate: new Date(SESSION_DATE),
          sessionType: 'MORNING',
          status: BookingStatus.BOOKED,
        });
        priorityPlan.push({ s, bookingId });
      }
    }
    await prisma.patient.createMany({ data: patients });
    await prisma.booking.createMany({ data: bookings });

    // ── PHASE 1: concurrent enqueue across all sessions ──
    const enqStart = performance.now();
    const enqLatencies: number[] = [];
    await Promise.all(
      enqueuePlan.map(({ s, bookingId, source }) =>
        timed(() => consult.enqueueBooking(source, s.key, bookingId)).then((r) => {
          enqLatencies.push(r.ms);
        }),
      ),
    );
    const enqWall = performance.now() - enqStart;

    // authoritative post-enqueue order per session
    const ordered = new Map<number, string[]>();
    for (const s of sessions) ordered.set(s.idx, await queue.list(s.key));
    // every session enqueued exactly PER_SESSION distinct tokens
    for (const s of sessions) {
      const q = ordered.get(s.idx)!;
      expect(q.length).toBe(PER_SESSION);
      expect(new Set(q).size).toBe(PER_SESSION); // no dup token from concurrent INCR
    }

    // ── PHASE 2: simultaneous mixed-op storm across ALL sessions ──
    const ops: Array<() => Promise<unknown>> = [];
    for (const s of sessions) {
      const q = ordered.get(s.idx)!;
      // 5 DONE presses (pop current front each; lock serialises them)
      for (let k = 0; k < 5; k++) ops.push(() => consult.markDone(s.key));
      // no-shows on mid/back tokens
      for (const i of [8, 13, 18, 23, 27]) ops.push(() => consult.markNoShow(s.key, q[i]));
      // skips on a couple of tokens
      for (const i of [4, 20]) ops.push(() => consult.skip(s.key, q[i]));
      // emergency priority inserts (new bookings)
      for (const p of priorityPlan.filter((x) => x.s.idx === s.idx)) {
        ops.push(() => consult.priorityInsert(TokenSource.WALK_IN, s.key, p.bookingId));
      }
    }
    // shuffle so sessions genuinely interleave under load
    for (let i = ops.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ops[i], ops[j]] = [ops[j], ops[i]];
    }

    const stormStart = performance.now();
    const stormResults = await Promise.all(ops.map((op) => timed(op)));
    const stormWall = performance.now() - stormStart;
    const stormLatencies = stormResults.map((r) => r.ms).sort((a, b) => a - b);

    // ── CORRECTNESS: per-session, under no remaining concurrency ──
    for (const s of sessions) {
      const q = await queue.list(s.key);

      // (1) no duplicate tokens — rank/dup corruption check
      expect(new Set(q).size).toBe(q.length);

      // (2) cross-session isolation + valid placement: every queued token maps
      //     to a booking owned by THIS session's doctor — never a leaked foreign
      //     booking from another clinic/doctor under concurrent load.
      const queuedBookingIds: string[] = [];
      for (const tok of q) {
        const bid = await queue.bookingIdFor(tok, s.key);
        expect(bid).toBeTruthy();
        queuedBookingIds.push(bid!);
      }
      if (queuedBookingIds.length > 0) {
        const owned = await prisma.booking.findMany({
          where: { id: { in: queuedBookingIds } },
          select: { id: true, doctorId: true },
        });
        expect(owned.length).toBe(queuedBookingIds.length); // none missing
        for (const b of owned) expect(b.doctorId).toBe(s.doctorId); // none foreign
      }

      // (3) at most one ACTIVE; if queue non-empty the front IS the ACTIVE one
      const activeIds = await prisma.booking.findMany({
        where: { doctorId: s.doctorId, status: BookingStatus.ACTIVE },
        select: { id: true },
      });
      expect(activeIds.length).toBeLessThanOrEqual(1);
      if (q.length > 0) {
        const frontBid = await queue.bookingIdFor(q[0], s.key);
        expect(activeIds.map((a) => a.id)).toEqual([frontBid]);
      }

      // (4) NO LOST PLACEMENTS: the set of bookings the DB thinks are live
      //     (BOOKED|ACTIVE) is EXACTLY the set currently in the Redis queue.
      //     A BOOKED row missing from the queue = lost placement; a queued token
      //     whose row is COMPLETED/NO_SHOW = rank corruption. Either fails here.
      const liveRows = await prisma.booking.findMany({
        where: {
          doctorId: s.doctorId,
          status: { in: [BookingStatus.BOOKED, BookingStatus.ACTIVE] },
        },
        select: { id: true },
      });
      expect(new Set(liveRows.map((r) => r.id))).toEqual(new Set(queuedBookingIds));
    }

    // ── REPORT ──
    const enqSorted = [...enqLatencies].sort((a, b) => a - b);
    const stormOk = stormResults.filter((r) => r.ok).length;
    const enqThroughput = (enqueuePlan.length / enqWall) * 1000;
    const stormThroughput = (ops.length / stormWall) * 1000;

    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        '════════ QUEUE ENGINE LOAD TEST ════════',
        `sessions:           ${sessions.length} (${CLINICS} clinics x ${DOCTORS_PER_CLINIC} doctors)`,
        `enqueues:           ${enqueuePlan.length} concurrent`,
        `storm ops:          ${ops.length} concurrent (DONE/no-show/skip/priority), ${stormOk} fulfilled`,
        '── ENQUEUE ──',
        `  wall:             ${enqWall.toFixed(0)} ms`,
        `  throughput:       ${enqThroughput.toFixed(0)} ops/s`,
        `  latency p50/p95/p99/max: ${pct(enqSorted, 50).toFixed(1)}/${pct(enqSorted, 95).toFixed(1)}/${pct(enqSorted, 99).toFixed(1)}/${enqSorted[enqSorted.length - 1].toFixed(1)} ms`,
        '── MIXED-OP STORM ──',
        `  wall:             ${stormWall.toFixed(0)} ms`,
        `  throughput:       ${stormThroughput.toFixed(0)} ops/s`,
        `  latency p50/p95/p99/max: ${pct(stormLatencies, 50).toFixed(1)}/${pct(stormLatencies, 95).toFixed(1)}/${pct(stormLatencies, 99).toFixed(1)}/${stormLatencies[stormLatencies.length - 1].toFixed(1)} ms`,
        '── CORRECTNESS ──',
        '  no duplicate tokens, no lost placements, no rank corruption,',
        '  <=1 ACTIVE/session, zero cross-session leakage. ALL PASS.',
        '════════════════════════════════════════',
      ].join('\n'),
    );

    // storm should make real progress (locks not deadlocking)
    expect(stormOk).toBeGreaterThan(0);
  }, 120000);
});
