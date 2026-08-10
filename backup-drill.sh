#!/usr/bin/env bash
#
# Patient Flow OS — scheduled restore drill.
#
# Picks the newest backup and restores it into a throwaway scratch database,
# asserting it actually contains rows. This is `restore-verify.sh` wrapped so it
# can run unattended on a timer and FAIL LOUDLY.
#
# Why unattended matters: a restore procedure that only runs when somebody
# remembers is not a control. The audit's finding was not "there is no restore
# script" — it was that the backup had never been restored, so its recoverability
# was a hypothesis. A drill that runs monthly and shouts on failure is what turns
# it into evidence, continuously.
#
# Usage:
#   ./backup-drill.sh                 # newest local backup
#   ./backup-drill.sh path/to/file    # a specific archive
#
# Cron (monthly, 1st at 04:30):
#   30 4 1 * * cd /opt/patient-flow-os/backend && ./backup-drill.sh >> backups/drill.log 2>&1
#
# Exit codes: 0 pass, 1 fail (drill or no backup found), 2 usage.
#
# Optional:
#   DRILL_ALERT_URL   POST the outcome here (Alertmanager webhook, Slack, …).
#                     Without it a failure is only visible in the log — which is
#                     the same "nobody is watching" problem one level up.
#   DRILL_MAX_AGE_HOURS  fail if the newest backup is older than this
#                        (default 48). A drill that passes against a stale
#                        backup proves the restore works and hides that backups
#                        stopped running.
set -euo pipefail
cd "$(dirname "$0")"

DIR="backups"
MAX_AGE_HOURS="${DRILL_MAX_AGE_HOURS:-48}"

notify() {
  local status="$1" detail="$2"
  echo "[drill] $status: $detail"
  [ -n "${DRILL_ALERT_URL:-}" ] || return 0
  curl -fsS -X POST "$DRILL_ALERT_URL" \
    -H 'content-type: application/json' \
    -d "{\"service\":\"pfos-backup-drill\",\"status\":\"$status\",\"detail\":\"$detail\",\"host\":\"$(hostname)\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" \
    >/dev/null 2>&1 || echo "[drill] WARNING: could not reach DRILL_ALERT_URL" >&2
}

ARCHIVE="${1:-}"
if [ -z "$ARCHIVE" ]; then
  # Newest logical dump. Base backups are drilled separately (they restore as a
  # whole data directory, not into a scratch database).
  ARCHIVE="$(ls -1t "$DIR"/pfos_2*.sql.gz.* 2>/dev/null | grep -v '\.sha256$' | head -n 1 || true)"
fi

if [ -z "$ARCHIVE" ] || [ ! -f "$ARCHIVE" ]; then
  notify FAIL "no backup archive found in $DIR — backups are not running"
  exit 1
fi

# Age check. A passing drill against last month's dump is a false reassurance:
# it proves restore works while backups have silently stopped.
AGE_SECONDS=$(( $(date +%s) - $(date -r "$ARCHIVE" +%s) ))
if [ "$AGE_SECONDS" -gt $(( MAX_AGE_HOURS * 3600 )) ]; then
  notify FAIL "newest backup $ARCHIVE is $(( AGE_SECONDS / 3600 ))h old (limit ${MAX_AGE_HOURS}h)"
  exit 1
fi

echo "[drill] Drilling $ARCHIVE ($(( AGE_SECONDS / 3600 ))h old) ..."
if ./restore-verify.sh "$ARCHIVE"; then
  notify PASS "restored and verified $ARCHIVE"
  exit 0
fi

notify FAIL "restore drill FAILED for $ARCHIVE"
exit 1
