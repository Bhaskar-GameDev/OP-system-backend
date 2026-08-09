#!/usr/bin/env bash
#
# Patient Flow OS — encrypted Postgres backup.
#
# Dumps the database from the running container, ENCRYPTS it, optionally copies
# it OFF the machine, and prunes old copies.
#
# What changed and why: this script used to write a plain gzip into ./backups on
# the same disk as the Postgres volume. That is an unencrypted copy of every
# patient record sitting on an internet-facing host, and a single disk failure
# or ransomware event destroyed production and its only backup together.
#
# Manual:   ./backup.sh
# Cron (daily 02:30):
#   30 2 * * * cd /opt/patient-flow-os/backend && ./backup.sh >> backups/backup.log 2>&1
#
# Restore: see ./restore-verify.sh and BACKUP_RECOVERY.md. Never restore into
# the production database to "test" a backup.
#
# ─── Required configuration ──────────────────────────────────────────────────
#   BACKUP_AGE_RECIPIENT   age public key (age1...) — public-key encryption, so
#                          this host can WRITE backups but cannot READ them.
#                          Preferred: a stolen server yields no patient data.
#     or
#   BACKUP_PASSPHRASE_FILE path to a file holding a symmetric passphrase
#                          (openssl fallback for hosts without `age`).
#
# ─── Optional configuration ──────────────────────────────────────────────────
#   BACKUP_REMOTE_TARGET   rclone remote (e.g. "s3:pfos-backups/db") or an
#                          rsync destination ("user@host:/path"). Without this
#                          the backup stays on one disk and offsite separation
#                          is NOT satisfied — the script warns loudly.
#   BACKUP_KEEP_DAYS       local retention in days (default 14).
set -euo pipefail
cd "$(dirname "$0")"

CONTAINER="${BACKUP_PG_CONTAINER:-pfos_postgres}"
DB="${BACKUP_PG_DB:-patient_flow_os}"
PGUSER="${BACKUP_PG_USER:-pfos}"
DIR="backups"
KEEP_DAYS="${BACKUP_KEEP_DAYS:-14}"

mkdir -p "$DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"

# ─── Fail closed on encryption configuration ─────────────────────────────────
# A backup of patient data must never be written in the clear. If neither
# mechanism is configured we refuse rather than silently producing a plaintext
# dump, which is exactly the failure this script exists to remove.
ENCRYPTION_MODE=""
if [ -n "${BACKUP_AGE_RECIPIENT:-}" ]; then
  command -v age >/dev/null 2>&1 || {
    echo "[backup] ERROR: BACKUP_AGE_RECIPIENT is set but 'age' is not installed." >&2
    exit 1
  }
  ENCRYPTION_MODE="age"
elif [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  [ -r "${BACKUP_PASSPHRASE_FILE}" ] || {
    echo "[backup] ERROR: BACKUP_PASSPHRASE_FILE is not readable." >&2
    exit 1
  }
  ENCRYPTION_MODE="openssl"
else
  echo "[backup] ERROR: no encryption configured." >&2
  echo "[backup] Set BACKUP_AGE_RECIPIENT (preferred) or BACKUP_PASSPHRASE_FILE." >&2
  echo "[backup] Refusing to write an unencrypted dump of patient data." >&2
  exit 1
fi

OUT="$DIR/pfos_${STAMP}.sql.gz.${ENCRYPTION_MODE}"

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[backup] ERROR: container $CONTAINER is not running." >&2
  exit 1
fi

echo "[backup] Dumping $DB -> $OUT (encryption: $ENCRYPTION_MODE)"

# PIPESTATUS is checked below: without it a failing pg_dump is masked by a
# succeeding gzip/encrypt, and the script would report a "successful" backup of
# a truncated database.
set +e
if [ "$ENCRYPTION_MODE" = "age" ]; then
  docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$DB" --clean --if-exists \
    | gzip \
    | age -r "$BACKUP_AGE_RECIPIENT" -o "$OUT"
else
  docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$DB" --clean --if-exists \
    | gzip \
    | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
        -pass file:"$BACKUP_PASSPHRASE_FILE" -out "$OUT"
fi
STATUSES=("${PIPESTATUS[@]}")
set -e
for status in "${STATUSES[@]}"; do
  if [ "$status" -ne 0 ]; then
    echo "[backup] ERROR: backup pipeline failed (exit codes: ${STATUSES[*]})." >&2
    rm -f "$OUT"
    exit 1
  fi
done

# Guard against a truncated/empty artifact (e.g. disk full).
if [ ! -s "$OUT" ]; then
  echo "[backup] ERROR: artifact is empty, removing $OUT" >&2
  rm -f "$OUT"
  exit 1
fi

# Integrity anchor so a later restore can prove the file did not rot on disk or
# in transit.
sha256sum "$OUT" > "$OUT.sha256"

echo "[backup] OK: $(du -h "$OUT" | cut -f1)"

# ─── Offsite copy ────────────────────────────────────────────────────────────
# Separation is the point: a backup that only exists beside the database is not
# a backup, it is a second copy of the same failure domain.
if [ -n "${BACKUP_REMOTE_TARGET:-}" ]; then
  echo "[backup] Copying offsite -> ${BACKUP_REMOTE_TARGET}"
  if command -v rclone >/dev/null 2>&1 && [[ "$BACKUP_REMOTE_TARGET" == *:* && "$BACKUP_REMOTE_TARGET" != *@* ]]; then
    rclone copy "$OUT" "$BACKUP_REMOTE_TARGET"
    rclone copy "$OUT.sha256" "$BACKUP_REMOTE_TARGET"
  else
    scp "$OUT" "$OUT.sha256" "$BACKUP_REMOTE_TARGET"
  fi
  echo "[backup] Offsite copy complete."
else
  echo "[backup] WARNING: BACKUP_REMOTE_TARGET is unset — this backup exists only" >&2
  echo "[backup] WARNING: on the same host as the database. Disk loss destroys both." >&2
fi

echo "[backup] Pruning local copies older than ${KEEP_DAYS} days ..."
find "$DIR" -name 'pfos_*.sql.gz.*' -type f -mtime "+${KEEP_DAYS}" -print -delete
echo "[backup] Done."
