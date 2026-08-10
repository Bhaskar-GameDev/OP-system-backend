# Benchmarks

Run with `npm run bench` (see `scripts/benchmark.ts`). It creates its own clinic,
doctor and session, and removes them afterwards.

**These are laptop numbers.** They are a baseline for comparing before/after on
the same machine, not a prediction of production performance. The audit's
requirement — a load test at expected peak concurrency on production-shaped
hardware — is still outstanding.

---

## Environment

| | |
|---|---|
| Date | 2026-08-10 |
| Machine | developer laptop, Windows 11 |
| Node | v24.14.0 |
| Postgres | 16-alpine in Docker, port 5433 |
| Redis | 7-alpine in Docker, port 6379 |
| Settings | `BENCH_DEPTHS=30,60`, `BENCH_ITERATIONS=100` |

Depths 30 and 60 are the realistic per-doctor queue range the audit named.

---

## Queue operations

| Depth | Operation | mean | p50 | p95 | max |
|---:|---|---:|---:|---:|---:|
| 30 | enqueue | 0.254 ms | 0.247 | 0.348 | 0.498 |
| 30 | etaForQueue | 0.695 ms | 0.660 | 0.908 | 1.976 |
| 60 | enqueue | 0.220 ms | 0.213 | 0.288 | 0.316 |
| 60 | etaForQueue | 0.676 ms | 0.654 | 0.849 | 1.210 |

**Reading this:** neither operation degrades between depth 30 and 60. Enqueue is
a single Lua script — its cost is independent of queue length by construction —
and `etaForQueue` is one `ZRANGE` plus an in-process map. There was no problem
here, and now that is measured rather than assumed.

## Broadcast fan-out — the N+1, before and after

Every queue mutation triggers one broadcast, for every active doctor.

| Depth | Pattern | Redis lookups | mean | p50 | p95 | max |
|---:|---|---:|---:|---:|---:|---:|
| 30 | per-entry (before) | **30** | 1.785 ms | 1.073 | 2.109 | 16.996 |
| 30 | batched (after) | **1** | 0.893 ms | 0.851 | 1.155 | 1.317 |
| 60 | per-entry (before) | **60** | 1.867 ms | 1.221 | 2.368 | 20.545 |
| 60 | batched (after) | **1** | 0.929 ms | 0.881 | 1.257 | 1.821 |

**Reading this:** the lookup count was exactly the queue depth — the N+1 the
audit identified, confirmed by counting round trips rather than inferring it
from timing. One `HGETALL` replaces all of them, because the token → booking
mapping was already a single Redis hash.

Mean roughly halves, but **the tail is the real result**: max drops from ~17–21 ms
to ~1.3–1.8 ms. On a local Redis a round trip is ~0.1 ms, so 60 sequential trips
are cheap; across a network, under load, with dozens of doctors mutating queues
concurrently, that multiplier is what would have hurt. The batched version is
also flat in queue depth, so it does not get worse as a clinic gets busier.

## Password verification

| | mean | p50 | p95 | max | sequential logins/sec |
|---|---:|---:|---:|---:|---:|
| bcrypt cost 12 | 156.3 ms | 156.5 | 157.7 | 157.7 | **6.4** |

**Reading this:** ~6 logins per second per core, and that is *by design* — cost
12 is what makes a stolen hash expensive to crack. Two consequences worth
stating plainly:

1. **Capacity.** A hospital's morning shift-start login burst is small (tens of
   staff), so this is fine. It would not survive being a public login route with
   thousands of concurrent users.
2. **Abuse surface.** Each attempt costs ~156 ms of CPU, which is why the login
   throttle checks its counter *before* the bcrypt comparison — a throttled
   attempt costs a Redis read instead. Without that ordering, the throttle
   itself would be a CPU amplifier.

## Postgres round trip

| | mean | p50 | p95 | max |
|---|---:|---:|---:|---:|
| `SELECT 1` | 0.316 ms | 0.291 | 0.432 | 1.573 |

Baseline for interpreting everything above: any operation materially slower than
this is doing real work, not paying for connectivity.

---

## What has NOT been measured

- **Concurrent load.** Every number here is sequential. Contention, connection
  pool saturation and event-loop lag under real concurrency are unmeasured.
- **Production hardware and network.** A VPS with network-attached storage and a
  Redis on another host will look different, particularly for the round-trip
  costs.
- **Realistic client fan-out.** Broadcast cost was measured for the server-side
  work, not for delivering to N connected sockets.
- **The projection tick** under a large event backlog.

These are the load test the audit asks for, and it still needs to run somewhere
production-shaped before launch.
