#!/bin/sh
# Production start for Orbit: the CMD of the production Dockerfile.
#
#   1. Apply every pending database migration (`prisma migrate deploy`).
#   2. Only when that succeeds, start the app (`npm start`, the command the image ran before).
#
# If the migrations do not all apply, this exits non-zero and the app never starts. That covers a
# migration that fails now, one that failed earlier and was never resolved, a database that cannot
# be reached, and a missing DATABASE_URL. A new image then never serves on a database it was not
# written for; while it is down (or never becomes healthy) the previous container is what serves,
# if the host keeps it running. There is deliberately no "continue anyway" and no switch to skip it.
#
# Recovering from a failed migration: undo what it changed, mark it with
# `node node_modules/prisma/build/index.js migrate resolve --rolled-back <migration name>`,
# then deploy an image whose migration is fixed. `migrate deploy` is safe to run again: it only
# applies what is not applied yet, and it holds a database lock so two starts never apply at once.
set -eu

# The app folder (/app in the image): this script lives in its scripts/ folder
cd "$(dirname "$0")/.."

log() { printf '[start] %s\n' "$*"; }
refuse() {
  printf '[start] %s\n' "$@" >&2
  printf '[start] Orbit is NOT starting.\n' >&2
  exit 1
}

if [ -z "${DATABASE_URL:-}" ]; then
  refuse "DATABASE_URL is not set. Orbit cannot run without its database."
fi

# The migration tool shipped inside the image, run directly. Never `npx prisma`: the image has no
# linked prisma command, so npx could fetch whatever version the registry serves at start time.
PRISMA_CLI=node_modules/prisma/build/index.js
if [ ! -f "$PRISMA_CLI" ]; then
  refuse "The migration tool is missing from this image ($PRISMA_CLI), so the database cannot be brought up to date."
fi

log "Applying database migrations..."
if ! node "$PRISMA_CLI" migrate deploy; then
  refuse \
    "Database migrations did not apply (the reason is above)." \
    "Starting now would run this version on a database it was not written for." \
    "Fix the migration (or the database connection) and deploy again; a migration that failed must first be undone and marked with 'migrate resolve --rolled-back <name>'."
fi

log "Database is up to date. Starting Orbit..."
exec npm start
