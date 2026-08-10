# Operations runbook

What to look at, and what to do, when Patient Flow OS misbehaves in production.

This document assumes the observability added in Sprint B is deployed:
structured JSON logs with a request id, `/metrics`, `/health`, `/health/ready`,
and the alert rules in `ops/prometheus/alerts.yml`.

**Status of alerting:** the stack that runs the rules now exists
(`ops/monitoring/`), but a receiver still has to be configured and verified.
Nothing pages anybody until `ops/monitoring/README.md` §3 has been performed —
stop the backend, watch `BackendDown` fire, and confirm the notification
*arrives*. Record the date it was last verified here:

| Alert delivery last verified | By | Receiver |
|---|---|---|
| _never_ | | |

---

## 0. First five minutes of any incident

```bash
# Is the process up and are its dependencies answering?
curl -s https://<domain>/health/ready | jq

# What does the container think?
docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml logs --tail=200 backend
```

`/health/ready` names the failing dependency in its body. `/health` (liveness)
answers without touching Postgres or Redis, so a 200 there plus a 503 on
`/health/ready` means the app is fine and something under it is not.

### Finding one request's story

Every response carries `x-request-id`, every error body repeats it as
`requestId`, and every log line for that request carries the same value.

```bash
docker compose -f docker-compose.prod.yml logs backend \
  | grep '"requestId":"<the-id>"'
```

Ask the reporting user for the id. It is in the error the app showed them.

---

## 1. Redis outage — the one that stops the clinic

**Symptoms:** `/health/ready` reports `redis: down`; token issue and queue
operations fail with 5xx; the desk cannot call the next patient.

**Why it is severe:** Redis holds the token counters *and* the live queue
ordering. Postgres keeps the encounters and the token numbers, so nothing is
lost permanently — but arrival ORDER exists only in Redis and is not
reconstructible.

**Immediate actions:**

1. Restart Redis: `docker compose -f docker-compose.prod.yml restart redis`.
   AOF persistence is enabled, so ordering usually survives.
2. Confirm recovery: `/health/ready` returns 200 and a test queue read works.
3. Check for duplicate token numbers. The counter re-seeds from the Postgres
   high-water mark inside the Lua script (`queue.service.ts`), so duplicates
   should be impossible — verify rather than assume, on the first incident.

**If ordering is lost:** the clinic falls back to calling patients by token
number read from the read model (`GET /op/sessions/:id/queue` still lists
waiting encounters). Tell the desk to work in token order until the queue is
rebuilt. **This fallback has not been rehearsed with clinic staff — do that
before go-live.**

---

## 2. Postgres unreachable

**Symptoms:** `/health/ready` reports `postgres: down`; the global exception
filter returns 503 with a retryable message (this is deliberate — clients treat
503 as retryable and 500 as permanent).

**Actions:** restart the container, check disk space on the VPS (`df -h` —
`pgdata` and the backups share the same filesystem), then check for a migration
that failed at startup. The entrypoint runs `prisma migrate deploy` under
`set -e`, so a failed migration aborts before the app starts: the backend
container will be restarting rather than serving.

---

## 3. Error-rate or latency alert

```promql
# Which routes are failing?
sum by (route) (rate(pfos_http_request_duration_seconds_count{status=~"5.."}[5m]))

# Where is the time going?
histogram_quantile(0.95, sum by (le, route) (rate(pfos_http_request_duration_seconds_bucket[5m])))
```

Then pull the matching log lines by route and read the `requestId` of a failing
one. 5xx lines carry a stack; 4xx are logged at `warn` without one, on purpose.

---

## 4. Authentication failure spike

```promql
sum by (scope, reason) (rate(pfos_auth_failures_total[5m]))
sum by (scope)         (rate(pfos_login_throttled_total[5m]))
```

- `scope="staff"` or `"doctor"` — a credential attack against hospital-wide
  access. The throttle (10 failures per username, 30 per IP, 15-minute window)
  is already slowing it. Consider rotating the targeted account's password,
  which now also ends every existing session for it.
- `scope="patient", reason="no_otp"` — usually not an attack. It most often
  means SMS delivery is failing, so patients never receive a code to submit.
  Check `pfos_integration_calls_total{provider="msg91"}`.

---

## 5. Projection lag

**Symptom:** `pfos_projection_lag_events` rising, or
`pfos_projection_failures_total` incrementing.

**Why it matters:** this is a silent failure. Every endpoint still answers 200
while dashboards and the display board show the past.

**Actions:** look for `op projection tick failed` in the logs. The projection is
idempotent and resumable — it drains from a persisted cursor — so a restart is
safe. If the read model is corrupt rather than merely behind,
`ProjectionRunner.rebuild()` replays the whole stream without re-notifying.

---

## 6. Integration failures

```promql
sum by (provider, outcome) (rate(pfos_integration_calls_total[10m]))
```

- **msg91** failing → no patient can log in. Check the auth key, the DLT
  template registration, and the MSG91 dashboard.
- **razorpay** failing → bookings cannot be paid for.
- **fcm** with `outcome="not_configured"` → push is silently disabled and no
  patient is told their turn is approaching. Push failures are swallowed by
  design so a provider outage cannot undo a booking, which is exactly why this
  counter is the only signal that it is happening.

---

## 7. Deployment

`./deploy.sh` now does the safety work itself:

1. **Takes a backup first** and refuses to deploy if it fails. A rollback cannot
   undo a migration, so the pre-deploy dump is the only way back from a bad one.
2. Records the currently running image as a rollback target.
3. Builds, starts, and waits for the container to report healthy — which now
   means `/health/ready` returned 200, so Postgres and Redis are both answering.
4. **If it never becomes ready, it re-tags the previous image and restarts on
   it automatically**, then tells you plainly that the DATABASE was not rolled
   back with it.

### Rehearse on staging first

```bash
./deploy.sh --staging --domain staging.api.myclinic.com
```

Staging runs the same compose file and the same `NODE_ENV=production`, with its
own project, containers, volumes and env file (`.env.staging`). It is the place
to run a migration for the first time. Populate it from a restored production
backup when the migration's behaviour depends on real data shape.

### After a rollback

The schema is still the new one. If the deploy applied a migration, the old code
is now running against a newer schema — which may work (additive changes) or may
not. Check `backups/` for the pre-deploy dump and read §5b of
`BACKUP_RECOVERY.md` before assuming the rollback is complete.

### Watch after any deploy

```promql
sum(rate(pfos_http_request_duration_seconds_count{status=~"5.."}[5m]))
pfos_projection_lag_events
```

---

## 8. Backups — is the schedule actually running?

The audit's open question was whether any cron exists on the production host. A
committed crontab answers nothing on its own:

```bash
ls -l /etc/cron.d/pfos-backups          # installed?
grep CRON /var/log/syslog | grep pfos   # fired?
ls -lt /opt/patient-flow-os/backend/backups | head   # produced artefacts?
tail -20 /opt/patient-flow-os/backend/backups/drill.log   # last drill result
```

A drill failure means the newest backup could not be restored, **or** that
backups have stopped and the newest one is stale. Both are the same severity.

---

## 9. Escalation

**Unfilled, and required before launch:** who is on call, through what channel,
and what the response-time expectation is. The audit lists this as an open
question. Fill it in here.

| Role | Name | Contact | Hours |
|---|---|---|---|
| Primary on-call | _unassigned_ | | |
| Backup | _unassigned_ | | |
| Hospital-side contact | _unassigned_ | | |
