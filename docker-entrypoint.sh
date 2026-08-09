#!/bin/sh
# Apply migrations, optionally seed demo data, then start the backend.
set -e

echo "[entrypoint] Applying database migrations..."
npx prisma migrate deploy

# Seeding defaults to OFF.
#
# It used to default to ON, which meant every container start re-created staff
# accounts with documented demo passwords (including a super-admin) and issued
# deleteMany against live bookings. Opt in explicitly, and never in production —
# the seed script itself refuses to run there, and the backend's startup
# validator rejects SEED_ON_START=true under NODE_ENV=production, so this check
# is the outermost of three.
if [ "${SEED_ON_START:-false}" = "true" ]; then
  if [ "${NODE_ENV}" = "production" ]; then
    echo "[entrypoint] FATAL: SEED_ON_START=true with NODE_ENV=production." >&2
    echo "[entrypoint] The demo seed creates known-password accounts and deletes live rows." >&2
    exit 1
  fi
  echo "[entrypoint] SEED_ON_START=true — seeding demo data (non-production only)..."
  npx prisma db seed
else
  echo "[entrypoint] Skipping demo seed (SEED_ON_START is not 'true')."
fi

echo "[entrypoint] Starting Patient Flow OS backend..."
exec node dist/main.js
