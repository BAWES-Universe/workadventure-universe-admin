# Prisma Deployment Quick Reference

## TL;DR - What to Run After Deployment

### Option 1: Automatic (Recommended)
Use the startup script that runs migrations automatically:
```dockerfile
# In Dockerfile, change CMD to:
CMD ["sh", "scripts/start.sh"]
```

### Option 2: Manual Post-Deploy
In Coolify, set **Post-Deploy Command**:
```bash
npx prisma migrate deploy
```

### Option 3: Manual via Docker
```bash
docker exec <container-name> npx prisma migrate deploy
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

## Using the Startup Script

The `scripts/start.sh` script automatically runs migrations before starting the app.

### Enable in Dockerfile

Update your Dockerfile:

```dockerfile
# Copy startup script
COPY scripts/start.sh ./scripts/start.sh
RUN chmod +x ./scripts/start.sh

# Use startup script instead of npm start
CMD ["sh", "scripts/start.sh"]
```

### What It Does

1. Checks if `DATABASE_URL` is set
2. Runs `npx prisma migrate deploy`
3. Starts the Next.js application
4. If migrations fail, logs warning but continues (prevents container crash)

## Troubleshooting

### "Migration failed" but container continues

This is intentional - the script logs a warning but doesn't crash. Check logs:
```bash
docker logs <container-name> | grep -i migration
```

Then run migrations manually if needed.

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

