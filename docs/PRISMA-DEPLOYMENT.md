# Prisma Deployment Quick Reference

## TL;DR - Migrations run when the container starts

The production image's CMD is `sh scripts/start.sh`. It runs `prisma migrate deploy` and starts the app
only if every migration applied. If a migration fails (or the database cannot be reached, or
`DATABASE_URL` is missing) the container exits non-zero and Orbit does NOT start, so a new image never
serves on a database it was not written for. Nothing needs to run after a deploy.

A Coolify post-deploy command `npx prisma migrate deploy` is no longer needed. It is harmless if it is
still set: by then the start script has applied everything, and `migrate deploy` only applies what is
pending.

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

### Strategy 2: Post-Deployment (Easiest)

Run migrations **after** container starts:

**Using startup script** (recommended):
```dockerfile
# Update Dockerfile CMD
CMD ["sh", "scripts/start.sh"]
```

**Using Coolify Post-Deploy Command**:
```bash
npx prisma migrate deploy
```

**Pros**: Simple, automatic
**Cons**: Container starts before migrations complete (can cause brief errors)

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

The container stops on purpose: this version needs a database change that did not happen. Read the
reason above that line (`docker logs <container-name>`). Then:

1. If the database could not be reached, fix the connection and start the container again.
2. If a migration failed, Postgres rolled back that migration's own changes, but it is recorded as
   failed and every later start refuses (Prisma error P3009) until it is resolved. Fix the migration in
   a new image, mark the failed one as rolled back (from any container of this image, or a one-off one):
   ```bash
   node node_modules/prisma/build/index.js migrate resolve --rolled-back <migration name>
   ```
   and deploy the fixed image. Migrations that applied before the failing one stay applied.

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
docker exec <container-name> npx prisma migrate status
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
docker exec <container> npx prisma migrate status

# 5. Check application logs
docker logs -f <container>
```

## Quick Commands Reference

```bash
# Run migrations
docker exec <container> npx prisma migrate deploy

# Check status
docker exec <container> npx prisma migrate status

# View logs
docker logs <container>

# Check database connection
docker exec <container> npx prisma db pull
```

