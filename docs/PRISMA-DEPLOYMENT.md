# Prisma Deployment Quick Reference

## TL;DR - Migrations run when the container starts

The production image's CMD is `sh scripts/start.sh`. It runs `prisma migrate deploy` and starts the app
only if every migration applied. If a migration fails (or the database cannot be reached, or
`DATABASE_URL` is missing) the container exits non-zero and Orbit does NOT start, so a new image never
serves on a database it was not written for. Nothing needs to run after a deploy.

Whether users then still reach the previous version depends on the host: with Coolify's health check
ON the old container keeps serving and the deploy is marked failed; with it OFF the old container is
removed anyway, so Orbit is down until a fixed image is deployed, and the new container retries in a
loop (restart policy). Each retry refuses again without changing anything (Prisma P3009, and a database
lock while applying). With the check ON, the old version runs on a database where the release's earlier
migrations did apply, so migrations must only add things (new tables, nullable or defaulted columns)
and never rename or drop what the old code uses. The app does not listen until the migrations finish,
so the health check start period must be longer than the longest migration: if Coolify gives up first,
it kills the new container mid-migration (see "Troubleshooting"). Settings: docs/COOLIFY-SETUP.md.

Do not configure a Coolify post-deploy migration command (`npx prisma migrate deploy`): the container
already applies migrations at startup, and a post-deploy hook runs only after the new code is serving.
`npx` is also not a pinned path to the Prisma CLI bundled in the image. Drop such a hook after the first
good deploy of an image that migrates at start.

To check by hand:
```bash
docker exec <container-name> node node_modules/prisma/build/index.js migrate status
```

## Understanding Prisma in Production

### What Happens During Build

1. ✅ **Prisma Client is generated** during Docker build
2. ✅ **Client is included** in the final image
3. ❌ **Database migrations are NOT run** during build

### What You Need to Do After Deployment

1. ✅ **Run migrations** to update database schema
2. ✅ **Verify connection** to database
3. ✅ **Check migration status**

## Migration Commands

### Production Commands (Safe)

```bash
# Apply pending migrations (SAFE - use this in production)
npx prisma migrate deploy

# Check migration status
npx prisma migrate status

# Generate client (already done in build, but can re-run if needed)
npx prisma generate
```

### Development Commands (NOT for Production)

```bash
# ❌ DON'T USE IN PRODUCTION - can cause data loss
npx prisma migrate dev

# ❌ DON'T USE IN PRODUCTION - bypasses migrations
npx prisma db push
```

## Migration Strategies

### Strategy 1: Pre-Deployment (Safest)

Run migrations **before** deploying new code:

1. Pull latest code
2. Run `npx prisma migrate deploy` locally (pointing to production DB)
3. Deploy new container

**Pros**: Can verify migrations work before deploying
**Cons**: Requires database access from CI/CD or local machine

### Strategy 2: At container start (what the image does)

The image's CMD is `sh scripts/start.sh`: migrations are applied before the app starts, and the app
never starts if they fail. Do not add a Coolify post-deploy migration command on top: it runs after the
new code already serves, through an unpinned `npx`.

**Pros**: Automatic; new code never serves on an older schema
**Cons**: A failed migration keeps the new container from starting until it is fixed

### Strategy 3: Init Container (Advanced)

Use a separate init container that runs migrations before the main app starts.

**Pros**: Clean separation, migrations complete before app starts
**Cons**: More complex setup

## The Startup Script

`scripts/start.sh` is the production image's CMD (see the Dockerfile).

### What It Does

1. Refuses to start if `DATABASE_URL` is not set
2. Runs `prisma migrate deploy` with the Prisma CLI shipped in the image (never `npx`, which could fetch another version)
3. Starts the app (`npm start`) only if that succeeded
4. If the migrations do not all apply, exits non-zero and the app does not start. There is no "continue anyway"

## Troubleshooting

### "Database migrations did not apply ... Orbit is NOT starting"

The new container refuses on purpose: this version needs a database change that did not happen. What
happens next depends on the Coolify health check:

- **Health check OFF** (production as of 26 Nov 2026): the old container is already gone, so Orbit is
  down. The new container stops, or Docker keeps restarting it. Read the reason above that line with
  `docker logs <container-name>`.
- **Health check ON**: Coolify removes the new container, marks the deploy failed, and the old version
  keeps serving. Read the reason in that deploy's log in Coolify.

Then:

1. If the database could not be reached, fix the connection, then start the container again (check OFF)
   or redeploy (check ON).
2. If a migration failed, it is recorded as failed and every later start refuses (Prisma error P3009)
   until it is resolved. Migrations that applied before the failing one stay applied.
   - **First check whether the failed migration's changes are in the database.** A migration that
     errored as one transaction (the usual case: plain DDL and data statements, no explicit `COMMIT`)
     left nothing. A migration that was **killed** while it ran (Coolify giving up on the health check,
     a redeploy, OOM, `docker stop`) is usually finished and committed by Postgres anyway, while Prisma
     still records it as failed. One that commits part-way (an explicit `COMMIT`, or
     `CREATE INDEX CONCURRENTLY`) keeps what ran before the failure.
   - Then resolve it with the commands below, run in a one-off container (see "Running the Prisma CLI
     when the container will not start"):
     - all of its changes are there:
       ```bash
       node node_modules/prisma/build/index.js migrate resolve --applied <migration name>
       ```
     - none of them are: `migrate resolve --rolled-back <migration name>`, and deploy an image with the
       fixed migration. With the check OFF, stop the failed container before that; with it ON there is no
       failed container, and the one running is the old version that serves, so never stop it;
     - only some are: undo those by hand, then the same as "none of them are".
   - Never `--rolled-back` a migration whose changes are in the database: the next start would run it
     again, and it fails again or applies twice.

### Running the Prisma CLI when the container will not start

A container that refused to start has stopped, or Docker keeps restarting it (check OFF), or Coolify
removed it (check ON), so `docker exec` cannot reach it. Run the Prisma CLI shipped in the failed release's
image in a one-off container instead, on the same Docker network and with the same `DATABASE_URL`.
The commands below are written for the health check OFF. **With the check ON, read the paragraph after
them first**: two lines differ. On the server, with `C` set to the Orbit container's name (`docker ps -a`):

```bash
C=<container-name>
# The exact image the container runs (its ID, not a tag such as :latest, which can move after a later pull).
IMAGE=$(docker inspect "$C" --format '{{.Image}}')
# The network the database is reached on. If this prints more than one, use the one the database container is on.
docker inspect "$C" --format '{{range $name, $net := .NetworkSettings.Networks}}{{println $name}}{{end}}'
NET=<network name from the line above>
# The database link goes into a private temporary file, never onto the screen.
ENVF=$(umask 077; mktemp)
docker inspect "$C" --format '{{range .Config.Env}}{{println .}}{{end}}' | grep '^DATABASE_URL=' > "$ENVF"

docker run --rm --network "$NET" --env-file "$ENVF" "$IMAGE" node node_modules/prisma/build/index.js migrate status
# then, only after checking the database as described above, ONE of:
#   all of its changes are there:
docker run --rm --network "$NET" --env-file "$ENVF" "$IMAGE" node node_modules/prisma/build/index.js migrate resolve --applied <migration name>
#   none of them are (after undoing any partial ones). Check OFF: stop the failed container FIRST; if it
#   restarts after this, it runs the bad migration again, and then the fixed image refuses to start too.
#   Check ON: skip this docker stop line (there $C is the old version that is still serving).
docker stop "$C"
docker run --rm --network "$NET" --env-file "$ENVF" "$IMAGE" node node_modules/prisma/build/index.js migrate resolve --rolled-back <migration name>

rm -f "$ENVF"
```

This uses the image's own Prisma CLI by path, not `npx prisma`, which is not tied to that copy. With the
check OFF: after `--applied`, a restarting container picks it up on its next start, and one that stopped
starts with `docker start "$C"`; after `--rolled-back`, leave that container stopped and deploy the image
with the fixed migration.

**With the Coolify health check ON**, Coolify removes the failed new container and keeps the old version
serving, so `docker ps -a` shows only the old one. Its image does not have the new migration
(`migrate resolve` would say the migration could not be found). Set `C` to the running old container for
the network and `DATABASE_URL` above, but set `IMAGE` to the image of the failed deploy (the newest Orbit
image in `docker images`). Skip the `docker stop "$C"` line: here `$C` is the old version that is still
serving, and stopping it takes Orbit down. After `--applied`, redeploy that same release; after
`--rolled-back`, deploy the fixed one.

### "Prisma Client not found"

This shouldn't happen - the client is generated during build. If it does:
1. Rebuild the Docker image
2. Check that `node_modules/.prisma` is copied in Dockerfile

### "Database connection failed"

Check:
1. `DATABASE_URL` environment variable is set correctly
2. Database is accessible from container
3. Network configuration in Coolify

### "Migration already applied"

This is normal - `prisma migrate deploy` is idempotent. It's safe to run multiple times.

## Migration Status Check

Check which migrations have been applied:

```bash
docker exec <container-name> node node_modules/prisma/build/index.js migrate status
```

Output shows:
- ✅ Applied migrations
- ⏳ Pending migrations
- ❌ Issues with database

## Best Practices

1. ✅ **Always use `prisma migrate deploy`** in production
2. ✅ **Test migrations locally** before deploying
3. ✅ **Backup database** before running migrations
4. ✅ **Monitor logs** after deployment
5. ❌ **Never use `migrate dev`** in production
6. ❌ **Never use `db push`** in production

## Example: Full Deployment Flow

```bash
# 1. Build and push image (automatic via GitHub Actions)
git push origin main

# 2. In Coolify, update image to latest
ghcr.io/<username>/workadventure-universe-admin:latest

# 3. Deploy (migrations run automatically if using startup script)

# 4. Verify migrations
docker exec <container> node node_modules/prisma/build/index.js migrate status

# 5. Check application logs
docker logs -f <container>
```

## Quick Commands Reference

```bash
# Migrations run by themselves at every start; there is no command to run.

# Check status
docker exec <container> node node_modules/prisma/build/index.js migrate status

# View logs
docker logs <container>

# Container will not start: use a one-off container (Troubleshooting above)
```

