# Monitoring stack

Prometheus + Alertmanager for Patient Flow OS. Sprint B produced the metrics and
the alert rules; this directory is what runs them.

**The requirement is not "monitoring is installed". It is "a real failure reaches
a human."** §3 below is how you prove that, and until it has been done once,
alerting does not work no matter what is running.

---

## 1. Start it

On the production host, from `backend/ops/monitoring`:

```bash
# 1. Alertmanager config — the real one carries a webhook URL, so it is gitignored.
cp alertmanager.example.yml alertmanager.yml
$EDITOR alertmanager.yml          # set both receivers

# 2. Scrape credential, taken from the backend's own env file.
grep '^METRICS_TOKEN=' ../../.env.production | cut -d= -f2- > metrics_token
chmod 600 metrics_token

# 3. Up.
docker compose -f docker-compose.monitoring.yml -p pfos-monitoring up -d
```

If `METRICS_TOKEN` is empty in `.env.production`, the backend is serving no
metrics at all — in production the endpoint 404s without a token, by design.
Set one, redeploy the backend, then come back.

## 2. Check it is scraping

Neither service publishes a host port; that is deliberate, since the Prometheus
UI is an unauthenticated query interface over all of this system's operational
data. Reach it over SSH:

```bash
ssh -L 9090:localhost:9090 <host> \
  -o ExitOnForwardFailure=yes \
  'docker run --rm --network pfos-monitoring_monitoring nicolaka/netshoot \
     sh -c "curl -s http://prometheus:9090/-/ready"'
```

Simpler, from the host itself:

```bash
docker exec pfos_prometheus wget -qO- http://localhost:9090/-/ready
docker exec pfos_prometheus wget -qO- 'http://localhost:9090/api/v1/targets' \
  | grep -o '"health":"[a-z]*"'
```

`"health":"up"` for the `pfos-backend` job means metrics are flowing. `"down"`
with a 401 means the token file does not match the backend's `METRICS_TOKEN`.

## 3. Prove an alert reaches a human — do this once, before launch

A rule that fires into a void is not monitoring. Verify end to end:

```bash
# 1. Cause a real failure.
docker compose -f ../../docker-compose.prod.yml --env-file ../../.env.production stop backend

# 2. Watch the rule move pending -> firing (BackendDown has for: 1m).
docker exec pfos_prometheus wget -qO- 'http://localhost:9090/api/v1/alerts'

# 3. Confirm Alertmanager received it.
docker exec pfos_alertmanager wget -qO- 'http://localhost:9093/api/v2/alerts'

# 4. THE ACTUAL TEST: did the notification arrive where a person would see it?
#    Check the phone, the pager, the channel. If nothing arrived, the receiver is
#    wrong — fix it and repeat.

# 5. Restore service and confirm the resolved notification also arrives.
docker compose -f ../../docker-compose.prod.yml --env-file ../../.env.production start backend
```

Record the date this was last verified in `ops/RUNBOOK.md`, and repeat it
whenever the receiver changes. A silent receiver is indistinguishable from a
quiet system.

## 4. Thresholds

Every threshold in `../prometheus/alerts.yml` is marked **PROVISIONAL**. None
has been calibrated against production traffic, because none exists yet. After
the first week of real load, revisit them using the 90 days of history this
stack retains — particularly `HighServerErrorRate`, `SlowRequests` and
`AuthFailureSpike`, which are the ones most likely to cry wolf.

`RealtimeClientsGone` fires when no staff dashboard has been connected for 15
minutes. That is expected outside clinic hours; either silence it on a schedule
or accept the noise, but do not leave a rule firing nightly — an alert people
learn to ignore is worse than no alert.

## 5. What this does NOT cover

- **Log aggregation.** Logs are structured JSON on stdout with a request id, but
  nothing ships them off the host. A destroyed VPS takes its logs with it.
- **Uptime checks from outside.** Everything here runs on the same host it
  watches, so a host-level failure takes the monitoring down with the system.
  Add an external check (any third-party uptime monitor hitting `/health`) —
  this is the one gap that makes the difference between "we noticed" and "the
  hospital told us".
- **Tracing.** No spans, no distributed traces. The request id is the
  correlation mechanism.
