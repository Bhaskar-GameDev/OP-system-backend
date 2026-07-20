#!/bin/sh
# Apply migrations, seed demo data (idempotent), then start the backend.
set -e

echo "[entrypoint] Applying database migrations..."
npx prisma migrate deploy

if [ "${SEED_ON_START:-true}" = "true" ]; then
  echo "[entrypoint] Seeding demo data (idempotent)..."
  npx prisma db seed
else
  echo "[entrypoint] SEED_ON_START=false — skipping demo seed."
fi

echo "[entrypoint] Starting Patient Flow OS backend..."
exec node dist/main.js
