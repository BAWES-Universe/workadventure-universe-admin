#!/bin/sh
# Production start for Orbit: the CMD of the production Dockerfile.
#
#   1. Apply every pending database migration (`prisma migrate deploy`).
#   2. Only when that succeeds, start the app (`npm start`, the command the image ran before).
#
# If the migrations do not all apply, this exits non-zero and the app never starts. That covers a
# migration that fails now, one that failed earlier and was never resolved, a database that cannot
# be reached, and a missing DATABASE_URL. A new image then never serves on a database it was not
# written for. There is deliberately no "continue anyway" and no switch to skip it.
#
# What users see then depends on the host, not on this script:
#   - Coolify health check ON: the new container never becomes healthy, so Coolify keeps the old
#     container serving and marks the deploy failed. The old version then runs on a database where
#     the release's earlier migrations DID apply, so migrations must only add things (new tables,
#     nullable or defaulted columns) and never rename or drop what the old code uses.
#   - Health check OFF (production as of 26 Nov 2026): Coolify removes the old container after a fixed
#     wait whatever happens, so a failed migration means Orbit is DOWN until a fixed image is deployed.
#     The new container exits and Docker restarts it in a loop (restart policy unless-stopped).
# Either way the app does not listen until the migrations finish, so the health check start period
# must be longer than the longest migration: if Coolify gives up first, it removes the new container
# in the middle of a migration (see "killed" below). With the check off, a long migration is a gap
# with nothing serving.
#
# The restart loop cannot make a failed migration worse: `migrate deploy` refuses to apply anything
# while a migration is recorded as failed (Prisma P3009), and it holds a database lock while applying,
# so two starts never apply at once. A start that failed only because the database was unreachable
# simply succeeds on a later restart.
#
# Recovering from a migration recorded as failed: FIRST check whether its changes are in the database.
# A migration that errored as one transaction left nothing. But one that was KILLED while it ran (Coolify
# giving up on the health check, a redeploy, OOM, docker stop) is usually finished and committed by
# Postgres anyway, while Prisma still records it as failed; and one that commits part-way (explicit
# COMMIT, CREATE INDEX CONCURRENTLY) keeps what ran before the failure. Then, with
# `node node_modules/prisma/build/index.js migrate resolve ...`:
#   - all of its changes are there:  --applied <migration name>
#   - none of them are:              --rolled-back <migration name>, and deploy a fixed image
#   - only some are:                 undo those, then --rolled-back, and deploy a fixed image
# Before --rolled-back, stop a failed container that Docker keeps restarting (health check OFF), or its
# next start runs the bad migration again. Never stop the old container that is still serving (check ON).
# Commands, including how to run the CLI when this container will not start: docs/PRISMA-DEPLOYMENT.md.
# Never --rolled-back a migration whose changes are there: the next start would run it again.
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

# The migration tool shipped inside the image, run directly by path. Not `npx prisma`: npx is not a
# pinned path to this copy.
PRISMA_CLI=node_modules/prisma/build/index.js
if [ ! -f "$PRISMA_CLI" ]; then
  refuse "The migration tool is missing from this image ($PRISMA_CLI), so the database cannot be brought up to date."
fi

log "Applying database migrations..."
if ! node "$PRISMA_CLI" migrate deploy; then
  refuse \
    "Database migrations did not apply (the reason is above)." \
    "Starting now would run this version on a database it was not written for." \
    "Fix the database connection, or resolve a failed migration: check whether its changes are in the database, then 'migrate resolve --applied <name>' if all are, or undo any that are and 'migrate resolve --rolled-back <name>' before deploying a fixed image." \
    "Read the runbook first (docs/PRISMA-DEPLOYMENT.md, Troubleshooting): it has the commands, and when to stop this container."
fi

log "Database is up to date. Starting Orbit..."
exec npm start
