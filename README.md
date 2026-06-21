# Patient Flow OS — Backend

Token-based patient queue management. NestJS + Prisma (Postgres) + Redis (queue engine) + Socket.io.

## Prerequisites

- Node 20+ (tested on 24)
- Docker Desktop (for local Postgres + Redis)

## Quickstart

```bash
# 1. install deps
npm install

# 2. copy env (then fill real secrets — never commit .env)
cp .env.example .env

# 3. bring up Postgres + Redis
docker compose up -d

# 4. run the initial migration
npx prisma migrate dev --name init

# 5. run the queue-engine concurrency test (needs Redis up)
npm test

# 6. start the API
npm run start:dev
```

## Queue Engine — design rule

All token counters and queue ordering live in **Redis**, mutated only via
atomic ops (`INCR`, `ZADD`, Lua). No read-modify-write in app code for anything
touching token numbers or queue order. `test/token.concurrency.spec.ts` proves
collision-free / gap-free issuance under concurrent load against real Redis.

## Token issuance rule

Token numbers are issued ONLY as part of an atomic enqueue — never via a raw
route. A booking token must never exist without payment success (Payments step,
hard rule). App bookings are enqueued by the payment-confirm flow; walk-ins via
`POST /queue/enqueue { "source": "WALK_IN", "doctorId", "sessionDate", "sessionType" }`.

## Module map

`queue-engine` · `auth` · `bookings` · `payments` · `notifications` · `admin`
