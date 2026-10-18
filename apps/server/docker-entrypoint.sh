#!/bin/sh
# Start-up of the API container (both apps/server/Dockerfile and the single-service root Dockerfile).
#
# Runs as the unprivileged `node` user. It calls the tools inside node_modules directly instead of pnpm,
# because corepack would try to download pnpm for this user at run time, which fails with no network.
# The image's files are owned by root and read-only to `node`; only /tmp is written (tsx's cache).
set -eu

cd /repo/apps/server

# Apply pending migrations (safe to repeat; a no-op when the schema is current).
./node_modules/.bin/prisma migrate deploy

# Demo accounts and scenarios. In production the seed refuses to run without a strong SEED_PASSWORD
# and replaces the published demo password on accounts an older seed created.
if [ "${SEED_ON_START:-false}" = "true" ]; then
  ./node_modules/.bin/tsx prisma/seed.ts
fi

# exec: the server becomes PID 1, so `docker stop` (SIGTERM) reaches its graceful shutdown.
exec node dist/index.js
