#!/usr/bin/env bash
#
# Patient Flow OS — one-shot deploy to a fresh Ubuntu VPS.
#
# Does everything: installs Docker if missing, writes .env.production (from flags
# or interactive prompts), brings up the hardened prod stack behind Caddy/HTTPS,
# and waits until the backend reports healthy.
#
# Run from the backend/ directory (where the compose files live):
#
#   sudo ./deploy.sh --domain api.myclinic.com
#
# Non-interactive example (CI / re-runs):
#
#   sudo ./deploy.sh \
#     --domain api.myclinic.com \
#     --db-password "$(openssl rand -hex 24)" \
#     --redis-password "$(openssl rand -hex 24)" \
#     --jwt-secret "$(openssl rand -hex 32)" \
#     --msg91-key KEY --razorpay-key-id ID --razorpay-key-secret SECRET
#
# Secrets already present in an existing .env.production are preserved unless a
# flag overrides them, so re-running to update code is safe.
set -euo pipefail

cd "$(dirname "$0")"

COMPOSE="docker-compose.prod.yml"
ENV_FILE=".env.production"

# ── defaults / arg parsing ────────────────────────────────────────────────
DOMAIN=""; DB_PASSWORD=""; REDIS_PASSWORD=""; JWT_SECRET=""
MSG91_KEY=""; MSG91_SENDER=""; MSG91_TEMPLATE=""
RZP_KEY_ID=""; RZP_KEY_SECRET=""; RZP_WEBHOOK_SECRET=""
FCM_PATH=""; SEED_ON_START=""; METRICS_TOKEN=""
SKIP_BACKUP="false"; STAGING="false"

for arg in "$@"; do
  case "$arg" in
    --domain=*)              DOMAIN="${arg#*=}" ;;
    --domain)                shift; DOMAIN="${1:-}" ;;
    --db-password=*)         DB_PASSWORD="${arg#*=}" ;;
    --redis-password=*)      REDIS_PASSWORD="${arg#*=}" ;;
    --jwt-secret=*)          JWT_SECRET="${arg#*=}" ;;
    --msg91-key=*)           MSG91_KEY="${arg#*=}" ;;
    --msg91-sender=*)        MSG91_SENDER="${arg#*=}" ;;
    --msg91-template=*)      MSG91_TEMPLATE="${arg#*=}" ;;
    --razorpay-key-id=*)     RZP_KEY_ID="${arg#*=}" ;;
    --razorpay-key-secret=*) RZP_KEY_SECRET="${arg#*=}" ;;
    --razorpay-webhook-secret=*) RZP_WEBHOOK_SECRET="${arg#*=}" ;;
    --fcm-path=*)            FCM_PATH="${arg#*=}" ;;
    --metrics-token=*)       METRICS_TOKEN="${arg#*=}" ;;
    # Deploy the STAGING instance instead: same images and same compose file,
    # its own project name, volumes, containers, env file and domain. This is
    # what makes "rehearse the migration before production" possible on one host.
    --staging)               STAGING="true" ;;
    # Escape hatch for the very first deploy, when there is no database to back
    # up yet. Never use it on a running instance.
    --skip-backup)           SKIP_BACKUP="true" ;;
    # Retained so existing deploy commands keep working; seeding is now always
    # off for a production deploy, so this flag is a no-op.
    --no-seed)               : ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  esac
done

# ── target: production (default) or staging ────────────────────────────────
# Staging exists so a migration or a release is exercised somewhere real before
# it reaches a clinic. It shares the compose file — a staging environment that
# drifts from production tests the wrong thing — and differs only in project
# name, container names, volumes and env file.
COMPOSE_ARGS=(-f "$COMPOSE")
PROJECT="pfos"
BACKEND_CONTAINER="pfos_backend"
DB_CONTAINER="pfos_postgres"
if [ "$STAGING" = "true" ]; then
  COMPOSE_ARGS=(-f "$COMPOSE" -f docker-compose.staging.yml)
  PROJECT="pfos-staging"
  ENV_FILE=".env.staging"
  BACKEND_CONTAINER="pfos_staging_backend"
  DB_CONTAINER="pfos_staging_postgres"
fi
COMPOSE_ARGS+=(-p "$PROJECT")

log() { printf '\033[1;34m[deploy]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[deploy] ERROR:\033[0m %s\n' "$*" >&2; }

# Read existing value from .env.production (so re-runs keep prior secrets).
prev() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | head -n1 || true; }

# ── 1. install Docker if missing ──────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Docker not found — installing via get.docker.com ..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  log "Docker present: $(docker --version)"
fi
if ! docker compose version >/dev/null 2>&1; then
  err "'docker compose' (v2) plugin missing. Install docker-compose-plugin and re-run."
  exit 1
fi

# ── 2. resolve config (flags > existing .env > prompt/generate) ───────────
[ -z "$DOMAIN" ]         && DOMAIN="$(prev DOMAIN)"
if [ -z "$DOMAIN" ]; then
  read -rp "Domain (DNS A record must already point here, e.g. api.myclinic.com): " DOMAIN
fi
[ -z "$DOMAIN" ] && { err "DOMAIN is required (Caddy needs it for HTTPS)."; exit 1; }

[ -z "$DB_PASSWORD" ]    && DB_PASSWORD="$(prev POSTGRES_PASSWORD)"
[ -z "$DB_PASSWORD" ]    && { DB_PASSWORD="$(openssl rand -hex 24)"; log "Generated Postgres password."; }

[ -z "$REDIS_PASSWORD" ] && REDIS_PASSWORD="$(prev REDIS_PASSWORD)"
[ -z "$REDIS_PASSWORD" ] && { REDIS_PASSWORD="$(openssl rand -hex 24)"; log "Generated Redis password."; }

[ -z "$JWT_SECRET" ]     && JWT_SECRET="$(prev JWT_SECRET)"
[ -z "$JWT_SECRET" ]     && { JWT_SECRET="$(openssl rand -hex 32)"; log "Generated JWT secret."; }

# Metrics are fail-closed: with no token the endpoint 404s in production. A
# generated token means monitoring CAN be wired up without a redeploy; it is
# useless to an attacker who cannot read this file.
[ -z "$METRICS_TOKEN" ]  && METRICS_TOKEN="$(prev METRICS_TOKEN)"
[ -z "$METRICS_TOKEN" ]  && { METRICS_TOKEN="$(openssl rand -hex 24)"; log "Generated metrics token."; }

# Optional integrations: flag > existing value > blank (dev-fallback stays on).
[ -z "$MSG91_KEY" ]          && MSG91_KEY="$(prev MSG91_AUTH_KEY)"
[ -z "$MSG91_SENDER" ]       && MSG91_SENDER="$(prev MSG91_SENDER_ID)"
[ -z "$MSG91_TEMPLATE" ]     && MSG91_TEMPLATE="$(prev MSG91_OTP_TEMPLATE_ID)"
[ -z "$RZP_KEY_ID" ]         && RZP_KEY_ID="$(prev RAZORPAY_KEY_ID)"
[ -z "$RZP_KEY_SECRET" ]     && RZP_KEY_SECRET="$(prev RAZORPAY_KEY_SECRET)"
[ -z "$RZP_WEBHOOK_SECRET" ] && RZP_WEBHOOK_SECRET="$(prev RAZORPAY_WEBHOOK_SECRET)"
[ -z "$FCM_PATH" ]           && FCM_PATH="$(prev FCM_SERVICE_ACCOUNT_PATH)"
# Demo seeding is never enabled by a production deploy. This script writes a
# production .env, and the seed creates staff accounts with documented passwords
# and deletes live bookings — the backend now refuses to start if it is ever
# true alongside NODE_ENV=production, so writing anything else here would only
# produce a container that will not boot. Previous values are deliberately NOT
# carried forward from an earlier .env.production.
SEED_ON_START="false"

# ── 3. write .env.production ───────────────────────────────────────────────
log "Writing $ENV_FILE ..."
umask 077   # secrets file readable only by owner
cat > "$ENV_FILE" <<EOF
# Generated by deploy.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). Contains secrets.
DOMAIN=$DOMAIN
POSTGRES_PASSWORD=$DB_PASSWORD
REDIS_PASSWORD=$REDIS_PASSWORD
JWT_SECRET=$JWT_SECRET
METRICS_TOKEN=$METRICS_TOKEN
OTP_EXPIRY_SECONDS=300
SEED_ON_START=$SEED_ON_START

MSG91_AUTH_KEY=$MSG91_KEY
MSG91_SENDER_ID=$MSG91_SENDER
MSG91_OTP_TEMPLATE_ID=$MSG91_TEMPLATE
INTEGRATIONS_TEST_MOBILE=

RAZORPAY_KEY_ID=$RZP_KEY_ID
RAZORPAY_KEY_SECRET=$RZP_KEY_SECRET
RAZORPAY_WEBHOOK_SECRET=$RZP_WEBHOOK_SECRET

FCM_SERVICE_ACCOUNT_PATH=$FCM_PATH
FCM_SERVICE_ACCOUNT_JSON=
NOTIFY_APPROACHING_AHEAD=3
NOTIFY_ARRIVAL_AHEAD=1
EOF

mkdir -p secrets   # so the read-only bind mount in compose always exists

# ── 4. pre-deploy backup ───────────────────────────────────────────────────
# Taken BEFORE anything changes, because the one thing a rollback cannot undo is
# a migration. `prisma migrate deploy` runs in the container entrypoint, and
# migrations are forward-only: restoring the previous image does not restore the
# previous schema. This dump is the only path back from a bad one.
if [ "$SKIP_BACKUP" = "true" ]; then
  log "Skipping pre-deploy backup (--skip-backup)."
elif docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
  log "Taking a pre-deploy backup ..."
  if BACKUP_PG_CONTAINER="$DB_CONTAINER" ./backup.sh; then
    log "Pre-deploy backup complete."
  else
    err "Pre-deploy backup FAILED. Refusing to deploy."
    err "Deploying without a backup means a bad migration has no way back."
    err "Fix the backup configuration, or pass --skip-backup if you accept that risk."
    exit 1
  fi
else
  log "No running database — first deploy, nothing to back up."
fi

# ── 5. remember the current image, so a failed deploy can be undone ────────
PREVIOUS_IMAGE="$(docker inspect --format '{{.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || true)"
if [ -n "$PREVIOUS_IMAGE" ]; then
  log "Current backend image: ${PREVIOUS_IMAGE:0:19} (rollback target)"
else
  log "No running backend — first deploy, no rollback target."
fi

# ── 6. build + start ───────────────────────────────────────────────────────
log "Building and starting the stack ..."
docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" up -d --build

# ── 7. health gate ─────────────────────────────────────────────────────────
# The container healthcheck now probes /health/ready, which returns 200 only
# when Postgres AND Redis answer — so "healthy" means the app can actually
# serve, not merely that Node is listening.
log "Waiting for the backend to report ready (migrations run first) ..."
HEALTHY="false"
for _ in $(seq 1 40); do
  status="$(docker inspect --format '{{.State.Health.Status}}' "$BACKEND_CONTAINER" 2>/dev/null || echo starting)"
  if [ "$status" = "healthy" ]; then HEALTHY="true"; break; fi
  printf '.'; sleep 5
done
printf '
'

# ── 8. roll back automatically if it never became ready ────────────────────
if [ "$HEALTHY" != "true" ]; then
  err "Backend did not become ready. Recent logs:"
  docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" logs --tail=50 backend

  if [ -z "$PREVIOUS_IMAGE" ]; then
    err "No previous image to roll back to (first deploy). The stack is left up"
    err "for inspection; fix the cause and re-run."
    exit 1
  fi

  err "Rolling back to the previous image ..."
  # Re-tag the previous image under the name compose built, then restart WITHOUT
  # rebuilding so the old binary comes back rather than the broken new one.
  IMAGE_NAME="$(docker inspect --format '{{index .Config.Image}}' "$BACKEND_CONTAINER" 2>/dev/null || echo '')"
  if [ -n "$IMAGE_NAME" ] && docker tag "$PREVIOUS_IMAGE" "$IMAGE_NAME"; then
    docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" up -d --no-build backend
  else
    err "Could not re-tag the previous image; attempting a plain restart."
    docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" up -d --no-build backend || true
  fi

  for _ in $(seq 1 24); do
    status="$(docker inspect --format '{{.State.Health.Status}}' "$BACKEND_CONTAINER" 2>/dev/null || echo starting)"
    if [ "$status" = "healthy" ]; then
      err "Rolled back to the previous image, which is healthy."
      err ""
      err "IMPORTANT: the DATABASE was NOT rolled back. If this deploy applied a"
      err "migration, the old code is now running against the new schema. Check"
      err "backups/ for the pre-deploy dump and see BACKUP_RECOVERY.md before"
      err "assuming the rollback is complete."
      exit 1
    fi
    printf '.'; sleep 5
  done

  err "Rollback did not become healthy either. The system is DOWN — escalate."
  err "See ops/RUNBOOK.md."
  exit 1
fi

log "Backend is ready."
docker compose "${COMPOSE_ARGS[@]}" --env-file "$ENV_FILE" ps
cat <<DONE

✅ Deployed. https://$DOMAIN (Caddy is issuing the TLS cert on first request —
   give it ~30s, then open the URL).

Next:
  - Logs:     docker compose -f $COMPOSE --env-file $ENV_FILE logs -f backend
  - Update:   git pull && ./deploy.sh --domain $DOMAIN   (re-uses saved secrets)
  - Staging:  ./deploy.sh --staging --domain staging.$DOMAIN  (rehearse first)
  - Backups:  install ops/cron/pfos-backups.crontab (nightly dump, weekly base
              backup, monthly restore drill)
  - Metrics:  METRICS_TOKEN is in $ENV_FILE; wire it into
              ops/prometheus/prometheus.example.yml on the monitoring host
  - Runbook:  ops/RUNBOOK.md
DONE
exit 0
