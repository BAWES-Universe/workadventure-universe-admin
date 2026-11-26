#!/bin/sh
set -e

# The app folder: /app in the dev image (tests point it at a scratch copy)
APP_DIR="${APP_DIR:-/app}"

# Check if node_modules is empty or missing critical packages
NEEDS_INSTALL=false

# Check if node_modules directory exists and has content
if [ ! -d "$APP_DIR/node_modules" ] || [ -z "$(ls -A "$APP_DIR/node_modules" 2>/dev/null)" ]; then
  echo "[Entrypoint] Node modules volume is empty. Installing dependencies..."
  NEEDS_INSTALL=true
# Check for specific critical packages that must exist
elif [ ! -d "$APP_DIR/node_modules/@radix-ui/react-dropdown-menu" ] || \
     [ ! -d "$APP_DIR/node_modules/@sentry/nextjs" ] || \
     [ ! -d "$APP_DIR/node_modules/next" ] || \
     [ ! -d "$APP_DIR/node_modules/react" ] || \
     [ ! -d "$APP_DIR/node_modules/recharts" ]; then
  echo "[Entrypoint] Node modules volume is missing critical packages. Installing dependencies..."
  NEEDS_INSTALL=true
# Verify package-lock.json exists and node_modules is in sync
elif [ -f "$APP_DIR/package-lock.json" ]; then
  # Check if node_modules/.package-lock.json exists and matches (npm 7+)
  if [ ! -f "$APP_DIR/node_modules/.package-lock.json" ]; then
    echo "[Entrypoint] Node modules may be out of sync. Verifying dependencies..."
    NEEDS_INSTALL=true
  fi
fi

# Install dependencies if needed
if [ "$NEEDS_INSTALL" = "true" ]; then
  cd "$APP_DIR"
  echo "[Entrypoint] Running npm install..."
  npm install --ignore-scripts
  echo "[Entrypoint] Dependencies installed successfully"
fi

# Always regenerate Prisma client to ensure it's in sync with schema
# This is necessary when using a named volume for node_modules
echo "[Entrypoint] Regenerating Prisma client to ensure schema sync..."
cd "$APP_DIR"
mv prisma.config.ts prisma.config.ts.bak 2>/dev/null || true
if ! npx prisma generate --schema=prisma/schema.prisma; then
  mv prisma.config.ts.bak prisma.config.ts 2>/dev/null || true
  echo "[Entrypoint] Prisma client generation failed (the reason is above). Orbit is NOT starting:" >&2
  echo "[Entrypoint] without a client that matches prisma/schema.prisma every database call would fail." >&2
  exit 1
fi
mv prisma.config.ts.bak prisma.config.ts 2>/dev/null || true
echo "[Entrypoint] Prisma client regeneration complete"

# Apply pending migrations. If they do not all apply, the dev server does NOT start: running the code
# on a database it was not written for only moves the failure to some later request, where it is
# much harder to read. Fix the migration (it is mounted from your checkout) and start the container
# again. A migration that failed part-way is recorded as failed: undo what it changed, or reset the
# local dev database, then mark it and start again:
#   docker compose run --rm --entrypoint npx admin-api prisma migrate resolve --rolled-back <migration name>
#   docker compose run --rm --entrypoint npx admin-api prisma migrate reset   (wipes the local dev database)
echo "[Entrypoint] Running database migrations..."
if ! npx prisma migrate deploy; then
  echo "[Entrypoint] Database migrations did not apply (the reason is above). The dev server is NOT starting." >&2
  echo "[Entrypoint] Fix the migration and start the container again. If one is recorded as failed, undo its changes (or reset the" >&2
  echo "[Entrypoint] local dev database) and run: docker compose run --rm --entrypoint npx admin-api prisma migrate resolve --rolled-back <migration name>" >&2
  exit 1
fi

# Seed default data (idempotent). The seed only adds default rows: it never changes the schema, so a
# failed seed cannot leave the code and the database out of step. It is reported and the dev server
# still starts, so a seed problem never locks you out of the app you need to fix it in.
echo "[Entrypoint] Checking if database needs seeding..."
npx prisma db seed || echo "[Entrypoint] ⚠️  Seed failed (the reason is above). The schema is up to date, so the dev server still starts." >&2

# Execute the main command
exec "$@"
