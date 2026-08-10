# Scaling out

What is now safe, what is still required, and what will break if you skip a step.

---

## The blocker that is now removed

Socket.io rooms used to live in the default **in-memory adapter** — a per-process
view of who is in which room. Adding a second backend replica would have meant a
client connected to instance A silently stopped receiving events emitted by
instance B. Every HTTP call would still succeed; the dashboard would just go
quiet. Partial and silent is the worst shape a failure can take.

`RedisIoAdapter` (`src/queue-engine/redis-io.adapter.ts`) is installed in
`main.ts` and fans events out through Redis pub/sub. It is enabled **even on a
single instance**, deliberately: the point is that adding a replica later cannot
introduce the failure.

`test/multi-instance-realtime.spec.ts` runs two complete backends against the
same Postgres and Redis and asserts cross-instance delivery — including that a
patient's private channel does *not* leak to a staff socket on the other
instance. It was verified to fail with the in-memory adapter, so it genuinely
tests what it claims.

---

## What is still required before running more than one instance

1. **Remove `container_name` from the backend service** in
   `docker-compose.prod.yml`. Docker refuses two containers with the same name,
   so `--scale backend=2` fails while it is set. The deploy script's health gate
   and rollback logic also address the backend by that fixed name and would need
   to change with it.

2. **Put a load balancer in front.** Caddy currently proxies to a single
   upstream. Multiple replicas need `reverse_proxy backend:3000 backend2:3000`
   or a dynamic upstream, plus a decision about sticky sessions — Socket.io's
   HTTP long-polling fallback requires them; pure WebSocket transport does not.
   The clients here use `transports: ['websocket']`, so sticky sessions are not
   strictly required, but a client that ever falls back to polling without them
   will fail handshakes.

3. **Check the singleton background jobs.** These currently assume one process:

   | Job | Schedule | What happens with N replicas |
   |---|---|---|
   | `ArchivalService.scheduledSweep` | 02:00 | N concurrent sweeps over the same rows |
   | `AnalyticsService.scheduledSummary` | 02:30 | N writers to the same `analytics_daily` rows |
   | `PaymentCleanupService` | every 15 min | N concurrent sweeps of stale payments |
   | `OpProjectionScheduler` | every 2s | N projectors draining the same cursor |

   The projection is idempotent and cursor-driven, and the sweeps are written
   against unique constraints, so the likely outcome is wasted work rather than
   corruption — **but none of this has been tested with concurrent runners.**
   Before scaling out, either add a Redis leader lock around each scheduled job
   or run them in a single dedicated worker instance with the schedulers disabled
   elsewhere. Do not assume idempotent means safe to run four times at once.

4. **Postgres connection pooling.** Each replica opens its own Prisma pool.
   Multiply the pool size by the replica count and compare against Postgres
   `max_connections` (default 100). PgBouncer is the usual answer past a couple
   of replicas.

---

## What scaling out does NOT fix

- **Redis is still a single point of failure**, and now carries the realtime
  fan-out as well as token counters and queue ordering. Its loss halts every
  replica simultaneously. Replication or Sentinel is a separate piece of work.
- **Postgres is still a single instance** with no replica and no read splitting.
- **One host.** Replicas on the same VPS survive a process crash, not a host
  failure.

Measured single-instance headroom is in `BENCHMARKS.md`; the honest summary is
that nothing in the current numbers demands a second replica yet. Scale because
a measurement says to, not because the option now exists.
