#!/usr/bin/env bash
#
# Patient Flow OS — physical base backup + WAL archive shipping (PITR).
#
# WHY THIS EXISTS ALONGSIDE backup.sh
#
#   backup.sh takes a nightly logical dump (pg_dump). That is the restore path
#   for "the database is gone" — simple, portable, and what restore-verify.sh
#   drills. Its weakness is the recovery POINT: everything written since the
#   last dump is lost, so the RPO is up to 24 hours. For a clinic that is a full
#   day of bookings, payments and consultation notes.
#
#   This script takes a physical base backup (pg_basebackup) and ships the
#   archived WAL segments alongside it. Together they support point-in-time
#   recovery: restore the base, replay WAL up to any moment, and the RPO drops
#   to the last archived segment (archive_timeout=300, so ≤5 minutes).
#
#   Both matter. The dump is the simpler, better-drilled path; PITR is the one
#   that limits data loss. Neither replaces the other.
#
# Usage:
#   ./basebackup.sh
#
# Cron (weekly, Sunday 03:30 — after the nightly dump window):
#   30 3 * * 0 cd /opt/patient-flow-os/backend && ./basebackup.sh >> backups/basebackup.log 2>&1
#
# Required configuration: the same encryption variables backup.sh uses
# (BACKUP_AGE_RECIPIENT preferred, or BACKUP_PASSPHRASE_FILE). A base backup is
# the entire database — it is never written in the clear.
#
# Optional:
#   BACKUP_REMOTE_TARGET  rclone remote or rsync destination (as in backup.sh)
#   WAL_KEEP_DAYS         WAL archive retention, default 8 (must exceed the
#                         interval between base backups, or the replay chain
#                         from the oldest base is broken)
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER="${BACKUP_PG_CONTAINER:-pfos_postgres}"
PGUSER="${BACKUP_PG_USER:-pfos}"
DIR="backups"
WAL_KEEP_DAYS="${WAL_KEEP_DAYS:-8}"
STAMP="$(date +%Y%m%d_%H%M%S)"

mkdir -p "$DIR"

# ─── Fail closed on encryption, exactly as backup.sh does ────────────────────
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null 2>&1 || {
    echo "[basebackup] ERROR: BACKUP_AGE_RECIPIENT is set but 'age' is not installed." >&2
    exit 1
  }
  MODE="age"
elif [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  [ -r "${BACKUP_PASSPHRASE_FILE}" ] || {
    echo "[basebackup] ERROR: BACKUP_PASSPHRASE_FILE is not readable." >&2
    exit 1
  }
  MODE="openssl"
else
  echo "[basebackup] ERROR: no encryption configured." >&2
  echo "[basebackup] Set BACKUP_AGE_RECIPIENT (preferred) or BACKUP_PASSPHRASE_FILE." >&2
  echo "[basebackup] Refusing to write an unencrypted copy of the database." >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[basebackup] ERROR: container $CONTAINER is not running." >&2
  exit 1
fi

# Archiving must actually be on, or the base backup has no WAL chain to replay
# and PITR silently degrades to "restore the base and lose everything after it".
ARCHIVE_MODE="$(docker exec "$CONTAINER" psql -tAq -U "$PGUSER" -d postgres -c 'SHOW archive_mode;' | tr -d '[:space:]')"
if [ "$ARCHIVE_MODE" != "on" ]; then
  echo "[basebackup] ERROR: archive_mode is '$ARCHIVE_MODE', expected 'on'." >&2
  echo "[basebackup] Point-in-time recovery is NOT available. Check docker-compose.prod.yml." >&2
  exit 1
fi

OUT="$DIR/pfos_base_${STAMP}.tar.gz.${MODE}"
echo "[basebackup] Base backup -> $OUT (encryption: $MODE)"

# Encrypt stdin to the given path, with whichever mechanism is configured.
encrypt_to() {
  local target="$1"
  if [ "$MODE" = "age" ]; then
    age -r "$BACKUP_AGE_RECIPIENT" -o "$target"
  else
    openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
      -pass file:"$BACKUP_PASSPHRASE_FILE" -out "$target"
  fi
}

# -X fetch includes the WAL needed to make the base internally consistent; the
# archive supplies everything after it. Checked with PIPESTATUS so a failing
# pg_basebackup is not masked by a succeeding encrypt.
set +e
docker exec "$CONTAINER" pg_basebackup -U "$PGUSER" -D - -F tar -X fetch -z -c fast \
  | encrypt_to "$OUT"
STATUSES=("${PIPESTATUS[@]}")
set -e
for status in "${STATUSES[@]}"; do
  if [ "$status" -ne 0 ]; then
    echo "[basebackup] ERROR: pipeline failed (exit codes: ${STATUSES[*]})." >&2
    rm -f "$OUT"
    exit 1
  fi
done

if [ ! -s "$OUT" ]; then
  echo "[basebackup] ERROR: artifact is empty, removing $OUT" >&2
  rm -f "$OUT"
  exit 1
fi
sha256sum "$OUT" > "$OUT.sha256"
echo "[basebackup] OK: $(du -h "$OUT" | cut -f1)"

# ─── Ship the WAL archive ────────────────────────────────────────────────────
# The base backup alone recovers to the moment it was taken. The WAL segments
# are what allow recovery to any later point — and they live on the same host,
# so they are as exposed as the database until they are copied off.
WAL_STAGE="$DIR/wal_${STAMP}.tar.gz.${MODE}"
echo "[basebackup] Packaging WAL archive -> $WAL_STAGE"
set +e
docker exec "$CONTAINER" tar -C /wal_archive -cz . | encrypt_to "$WAL_STAGE"
WAL_STATUSES=("${PIPESTATUS[@]}")
set -e
for status in "${WAL_STATUSES[@]}"; do
  if [ "$status" -ne 0 ]; then
    echo "[basebackup] ERROR: WAL packaging failed (exit codes: ${WAL_STATUSES[*]})." >&2
    echo "[basebackup] The base backup at $OUT is valid, but without WAL there is" >&2
    echo "[basebackup] no point-in-time recovery beyond the moment it was taken." >&2
    rm -f "$WAL_STAGE"
    exit 1
  fi
done
sha256sum "$WAL_STAGE" > "$WAL_STAGE.sha256"

# ─── Offsite ─────────────────────────────────────────────────────────────────
if [ -n "${BACKUP_REMOTE_TARGET:-}" ]; then
  echo "[basebackup] Copying offsite -> ${BACKUP_REMOTE_TARGET}"
  if command -v rclone >/dev/null 2>&1 && [[ "$BACKUP_REMOTE_TARGET" == *:* && "$BACKUP_REMOTE_TARGET" != *@* ]]; then
    rclone copy "$OUT" "$BACKUP_REMOTE_TARGET"
    rclone copy "$OUT.sha256" "$BACKUP_REMOTE_TARGET"
    rclone copy "$WAL_STAGE" "$BACKUP_REMOTE_TARGET"
    rclone copy "$WAL_STAGE.sha256" "$BACKUP_REMOTE_TARGET"
  else
    scp "$OUT" "$OUT.sha256" "$WAL_STAGE" "$WAL_STAGE.sha256" "$BACKUP_REMOTE_TARGET"
  fi
else
  echo "[basebackup] WARNING: BACKUP_REMOTE_TARGET is unset — base backup and WAL" >&2
  echo "[basebackup] WARNING: exist only on the host that holds the database." >&2
fi

# ─── Prune ───────────────────────────────────────────────────────────────────
# WAL retention must outlive the oldest base backup you intend to replay from,
# or the chain is broken and PITR fails at exactly the moment it is needed.
echo "[basebackup] Pruning WAL segments older than ${WAL_KEEP_DAYS} days ..."
docker exec "$CONTAINER" find /wal_archive -type f -mtime "+${WAL_KEEP_DAYS}" -print -delete || true
echo "[basebackup] Done."
