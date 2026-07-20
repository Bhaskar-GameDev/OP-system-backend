#!/usr/bin/env bash
#
# Patient Flow OS — Postgres backup. Dumps the DB from the running container to a
# gzip file and prunes old dumps. Meant to be run from cron.
#
# Manual:   ./backup.sh
# Cron (daily 02:30, keep logs):
#   30 2 * * * cd /opt/patient-flow-os/backend && ./backup.sh >> backups/backup.log 2>&1
#
# Restore (DESTRUCTIVE — drops current data):
#   gunzip -c backups/pfos_YYYYmmdd_HHMMSS.sql.gz \
#     | docker exec -i pfos_postgres psql -U pfos -d patient_flow_os
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER="pfos_postgres"
DB="patient_flow_os"
USER="pfos"
DIR="backups"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"   # delete dumps older than this

mkdir -p "$DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT="$DIR/pfos_${STAMP}.sql.gz"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[backup] ERROR: container $CONTAINER is not running." >&2
  exit 1
fi

echo "[backup] Dumping $DB -> $OUT"
docker exec "$CONTAINER" pg_dump -U "$USER" -d "$DB" --clean --if-exists \
  | gzip > "$OUT"

# Guard against a truncated/empty dump (e.g. disk full).
if [ ! -s "$OUT" ]; then
  echo "[backup] ERROR: dump is empty, removing $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

echo "[backup] OK: $(du -h "$OUT" | cut -f1)"
echo "[backup] Pruning dumps older than ${KEEP_DAYS} days ..."
find "$DIR" -name 'pfos_*.sql.gz' -type f -mtime "+${KEEP_DAYS}" -print -delete
echo "[backup] Done."
