# Backup & Recovery — Patient Flow OS

Covers what is backed up, how it is protected, how long it is kept, how to
restore it, and how we prove the restore works.

Scripts: `backup.sh` (create), `restore-verify.sh` (drill / restore rehearsal).

---

## 1. What is backed up

| Data | Mechanism | Covered |
|---|---|---|
| PostgreSQL — all patient, booking, encounter, payment, audit data | `pg_dump --clean --if-exists` (`backup.sh`, nightly) | Yes |
| PostgreSQL — physical base backup + archived WAL (point-in-time recovery) | `pg_basebackup` + `archive_command` (`basebackup.sh`, weekly) | Yes |
| Redis — token counters, live queue ordering | none | **No — see §7** |
| Uploaded files | n/a (the system stores none) | n/a |
| Secrets (`.env.production`) | out of band, operator-managed | **Not by this script** |

---

## 2. Encryption

`backup.sh` **refuses to run** without an encryption mechanism configured. It
will not produce a plaintext dump of patient data under any flag.

Two modes:

### age (preferred)

```bash
export BACKUP_AGE_RECIPIENT="age1qz...yourpublickey"
```

Public-key encryption. The production host holds only the **public** key, so it
can write backups but cannot read them. A stolen server therefore yields no
patient data — the private key lives with the operator, offline.

### openssl (fallback)

```bash
export BACKUP_PASSPHRASE_FILE=/etc/pfos/backup.pass   # chmod 600, root-owned
```

AES-256-CBC, PBKDF2, 200 000 iterations. Symmetric — the host holds the key that
decrypts its own backups, which is weaker than age. Use only where `age` cannot
be installed.

Every artifact is written with a `.sha256` sidecar for integrity verification at
restore time.

---

## 3. Offsite separation

```bash
export BACKUP_REMOTE_TARGET="s3:pfos-backups/db"      # rclone remote
# or
export BACKUP_REMOTE_TARGET="backup@10.0.0.9:/srv/pfos"   # scp/rsync target
```

Without this the script prints a loud warning: a backup on the same disk as the
database shares its failure domain and does not protect against disk loss,
ransomware or host termination.

> **INFRASTRUCTURE STEP — NOT DONE IN THIS REPOSITORY.** Provisioning the remote
> bucket/host, its credentials, versioning and object-lock is a deployment task.
> The scripts are ready; the destination must be created and configured by
> whoever operates the VPS.

Recommended remote configuration: versioning ON, object-lock / immutability ON
(so ransomware cannot delete history), server-side encryption ON, access limited
to a write-only credential for the backup host.

---

## 4. Retention

| Copy | Retention | Controlled by |
|---|---|---|
| Local (on the VPS) | 14 days, then pruned | `BACKUP_KEEP_DAYS` |
| Offsite | set on the remote (recommended: 35 daily, 12 monthly) | remote lifecycle policy — **infrastructure step** |

Retention for patient data must be reviewed against the clinical record-keeping
policy and any applicable regulation. **This document makes no compliance claim;
formal legal review is required.**

---

## 5. Restore procedure

### 5a. Rehearsal (safe — use this for drills)

```bash
export BACKUP_AGE_IDENTITY_FILE=/path/to/age-private-key   # or BACKUP_PASSPHRASE_FILE
./restore-verify.sh backups/pfos_20260809_023000.sql.gz.age
```

Creates a throwaway scratch database, restores into it, asserts that
`patients`, `doctors`, `clinics` and `bookings` exist and that `patients` is
non-empty, then drops the scratch database. **It never writes to the production
database** — the scratch name is generated inside the script and is checked
against the production name before anything runs.

An empty schema restores "successfully" and proves nothing, which is why the
row-count assertion exists.

### 5b. Real recovery (DESTRUCTIVE — production is down)

1. **Stop the application** so nothing writes during recovery:
   ```bash
   docker compose -f docker-compose.prod.yml stop backend
   ```
2. **Verify the artifact first** with §5a against the scratch database. Never
   discover a bad backup while production is empty.
3. **Restore:**
   ```bash
   age -d -i "$BACKUP_AGE_IDENTITY_FILE" backups/pfos_<stamp>.sql.gz.age \
     | gunzip \
     | docker exec -i pfos_postgres psql -U pfos -d patient_flow_os
   ```
   (`--clean --if-exists` is baked into the dump, so it drops and recreates
   objects.)
4. **Flush Redis** — see §7 — then restart:
   ```bash
   docker compose -f docker-compose.prod.yml start backend
   ```
5. **Verify** login, queue read, and token issue before reopening to patients.

---

## 6. RPO / RTO

| Objective | Value | Basis |
|---|---|---|
| **RPO** — restoring from the nightly dump | **24 hours** | `backup.sh` runs daily |
| **RPO** — restoring with point-in-time recovery | **≤ 5 minutes** | `archive_timeout=300` forces a WAL segment at least every 5 minutes |
| **RTO** (time to restore) | **~30 minutes** | measured against a 76 KB demo dump; **must be re-measured against production-sized data** |

Two numbers, because there are two restore paths and they are not equivalent.

The **dump** path is simple, portable and drilled monthly — restore one file and
the database is back as of last night. Up to a full clinic day of bookings,
consultations and payments is lost.

The **PITR** path (base backup + archived WAL) recovers to any moment up to the
last archived segment, so at most a few minutes are lost. It is more involved,
needs both artefacts, and **has not been drilled** — see §8. Do not assume the
5-minute figure until a real PITR restore has been performed and recorded in §9.

---

## 7. Redis is not backed up — known gap

Token counters and live queue ordering live in Redis. After a database restore:

- **Token numbers** self-heal. The enqueue script seeds each counter from the
  Postgres high-water mark on first use (`queue-engine/queue.service.ts`), so
  numbers do not restart at 1 and collide.
- **Queue ordering does NOT self-heal.** The arrival sequence for in-progress
  sessions is lost.

**Operational consequence:** after a restore during clinic hours, staff must
re-establish the waiting order manually from the reception screen. Rehearse this
with clinic staff before go-live.

---

## 8. Known gaps

**Closed since the P0 sprint:**

- ~~No WAL archiving~~ — `archive_mode=on` with a 5-minute `archive_timeout`
  (`docker-compose.prod.yml`), weekly `pg_basebackup` and WAL shipping via
  `basebackup.sh`. WAL lives on its own volume so archiving cannot fill the data
  directory and a base backup does not share a failure domain with its segments.
- ~~Restore drill is manual~~ — `backup-drill.sh` runs unattended from
  `ops/cron/pfos-backups.crontab`, fails when the newest backup cannot be
  restored **or when the newest backup is stale** (a drill passing against last
  month's dump would otherwise hide that backups stopped running), and POSTs to
  `DRILL_ALERT_URL` when configured.

**Still open:**

1. **Offsite destination is not provisioned.** `BACKUP_REMOTE_TARGET` is
   supported by both scripts and they warn loudly when it is unset — but nobody
   has created the bucket, the credentials or the object-lock policy. Until
   that exists, every backup still lives on the host it protects. **This is the
   single largest remaining DR gap.**
2. **PITR has never been rehearsed.** The archiving is configured and the
   artefacts are produced; a real base-backup-plus-WAL recovery has not been
   performed. An untested recovery path is a hypothesis, exactly as an untested
   backup was.
3. **The age private key is not escrowed.** Backups encrypted to a key that only
   one laptop holds are not recoverable if that laptop is lost.
4. Redis state is not captured (§7).
5. Secrets are not covered by this process.
6. No drill has run against production-sized data on production hardware, so the
   RTO figure is not trustworthy yet.

---

## 9. Drill log

Record every drill here. An unrecorded drill did not happen.

| Date | Artifact | Environment | Result | Notes |
|---|---|---|---|---|
| 2026-08-09 | `pfos_20260809_115438.sql.gz.openssl` | Local dev containers, isolated scratch database | **PASSED** | Verified: encrypted at rest (ciphertext contained no plaintext patient names), checksum valid, restored 13 patients / 6 doctors / 3 clinics / 8 bookings into a scratch DB which was then dropped. openssl mode. **This drill used development data on developer hardware — it validates the SCRIPTS, not the production deployment.** A drill against production-sized data on the production host is still required. |
| 2026-08-10 | `pfos_20260810_112408.sql.gz.openssl` | Local dev containers, isolated scratch database | **PASSED** | First run of the UNATTENDED drill (`backup-drill.sh`), the path cron will use. Checksum verified, restored 13 patients / 6 doctors / 3 clinics / 8 bookings into a scratch DB which was then dropped. The staleness guard was also exercised: `DRILL_MAX_AGE_HOURS=0` correctly exited 1 against a fresh backup, so a drill cannot pass while backups have silently stopped. **Development data on developer hardware — validates the SCRIPTS, not the production deployment.** |
