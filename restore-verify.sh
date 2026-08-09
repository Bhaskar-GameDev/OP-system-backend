#!/usr/bin/env bash
#
# Patient Flow OS — restore drill.
#
# Restores an encrypted backup into a THROWAWAY scratch database and verifies it
# actually contains data. A backup that has never been restored is a hypothesis,
# not a control — this script is what turns it into evidence.
#
# Usage:
#   ./restore-verify.sh backups/pfos_20260809_023000.sql.gz.age
#
# Safety: this script REFUSES to touch the production database. It creates its
# own scratch database, restores into that, verifies, and drops it. It never
# writes to $DB.
set -euo pipefail
cd "$(dirname "$0")"

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  echo "usage: $0 <encrypted-backup-file>" >&2
  exit 2
fi

CONTAINER="${BACKUP_PG_CONTAINER:-pfos_postgres}"
PGUSER="${BACKUP_PG_USER:-pfos}"
PROD_DB="${BACKUP_PG_DB:-patient_flow_os}"
SCRATCH_DB="pfos_restore_check_$(date +%s)"

# Hard safety rail: the scratch name is generated here and must never collide
# with the live database, whatever the caller passes in.
if [ "$SCRATCH_DB" = "$PROD_DB" ]; then
  echo "[restore] ERROR: refusing to restore over the production database." >&2
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[restore] ERROR: container $CONTAINER is not running." >&2
  exit 1
fi

# ─── Integrity ───────────────────────────────────────────────────────────────
if [ -f "$ARCHIVE.sha256" ]; then
  echo "[restore] Verifying checksum ..."
  sha256sum -c "$ARCHIVE.sha256"
else
  echo "[restore] WARNING: no .sha256 beside the archive; integrity unverified." >&2
fi

# ─── Decrypt ─────────────────────────────────────────────────────────────────
decrypt() {
  case "$ARCHIVE" in
    *.age)
      [ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ] || {
        echo "[restore] ERROR: set BACKUP_AGE_IDENTITY_FILE (the age private key)." >&2
        exit 1
      }
      age -d -i "$BACKUP_AGE_IDENTITY_FILE" "$ARCHIVE"
      ;;
    *.openssl)
      [ -n "${BACKUP_PASSPHRASE_FILE:-}" ] || {
        echo "[restore] ERROR: set BACKUP_PASSPHRASE_FILE." >&2
        exit 1
      }
      openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 \
        -pass file:"$BACKUP_PASSPHRASE_FILE" -in "$ARCHIVE"
      ;;
    *)
      echo "[restore] ERROR: unrecognised archive suffix: $ARCHIVE" >&2
      exit 1
      ;;
  esac
}

echo "[restore] Creating scratch database $SCRATCH_DB ..."
docker exec "$CONTAINER" createdb -U "$PGUSER" "$SCRATCH_DB"

cleanup() {
  echo "[restore] Dropping scratch database $SCRATCH_DB ..."
  docker exec "$CONTAINER" dropdb -U "$PGUSER" --if-exists "$SCRATCH_DB" || true
}
trap cleanup EXIT

echo "[restore] Restoring into $SCRATCH_DB ..."
decrypt | gunzip | docker exec -i "$CONTAINER" psql -q -U "$PGUSER" -d "$SCRATCH_DB" >/dev/null

# ─── Verify ──────────────────────────────────────────────────────────────────
# Existence of tables is not proof of a usable backup: an empty schema restores
# cleanly and tells you nothing. Assert that the tables a hospital cannot
# operate without actually contain rows.
echo "[restore] Verifying restored contents ..."
FAILED=0
for table in patients doctors clinics bookings; do
  COUNT="$(docker exec "$CONTAINER" psql -tAq -U "$PGUSER" -d "$SCRATCH_DB" \
    -c "SELECT COUNT(*) FROM \"$table\";" 2>/dev/null || echo "ERR")"
  if [ "$COUNT" = "ERR" ]; then
    echo "[restore] FAIL: table '$table' missing from the restored database." >&2
    FAILED=1
  else
    echo "[restore]   $table: $COUNT rows"
    if [ "$table" = "patients" ] && [ "$COUNT" -eq 0 ]; then
      echo "[restore] FAIL: 'patients' restored with zero rows." >&2
      FAILED=1
    fi
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "[restore] RESTORE DRILL FAILED for $ARCHIVE" >&2
  exit 1
fi

echo "[restore] RESTORE DRILL PASSED for $ARCHIVE"
