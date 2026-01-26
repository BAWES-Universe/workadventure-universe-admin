#!/bin/sh
set -e

# Check if node_modules is empty or missing critical packages
NEEDS_INSTALL=false

# Check if node_modules directory exists and has content
if [ ! -d "/app/node_modules" ] || [ -z "$(ls -A /app/node_modules 2>/dev/null)" ]; then
  echo "[Entrypoint] Node modules volume is empty. Installing dependencies..."
  NEEDS_INSTALL=true
# Check for specific critical packages that must exist
elif [ ! -d "/app/node_modules/@radix-ui/react-dropdown-menu" ] || \
     [ ! -d "/app/node_modules/next" ] || \
     [ ! -d "/app/node_modules/react" ]; then
  echo "[Entrypoint] Node modules volume is missing critical packages. Installing dependencies..."
  NEEDS_INSTALL=true
# Verify package-lock.json exists and node_modules is in sync
elif [ -f "/app/package-lock.json" ]; then
  # Check if node_modules/.package-lock.json exists and matches (npm 7+)
  if [ ! -f "/app/node_modules/.package-lock.json" ]; then
    echo "[Entrypoint] Node modules may be out of sync. Verifying dependencies..."
    NEEDS_INSTALL=true
  fi
fi

# Install dependencies if needed
if [ "$NEEDS_INSTALL" = "true" ]; then
  cd /app
  echo "[Entrypoint] Running npm install..."
  npm install --ignore-scripts
  echo "[Entrypoint] Dependencies installed successfully"
fi

# Always regenerate Prisma client to ensure it's in sync with schema
# This is necessary when using a named volume for node_modules
echo "[Entrypoint] Regenerating Prisma client to ensure schema sync..."
cd /app
mv prisma.config.ts prisma.config.ts.bak 2>/dev/null || true
npx prisma generate --schema=prisma/schema.prisma || {
  echo "[Entrypoint] Warning: Prisma client generation failed, but continuing..."
}
mv prisma.config.ts.bak prisma.config.ts 2>/dev/null || true
echo "[Entrypoint] Prisma client regeneration complete"

# Execute the main command
exec "$@"
