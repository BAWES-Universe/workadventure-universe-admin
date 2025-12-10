# Production Deployment Guide

This guide covers deploying the WorkAdventure Universe Admin application to production using Docker images from GitHub Container Registry (GHCR).

## Table of Contents

- [Overview](#overview)
- [GitHub Actions CI/CD](#github-actions-cicd)
- [Coolify Deployment](#coolify-deployment)
- [Prisma Database Migrations](#prisma-database-migrations)
- [Environment Variables](#environment-variables)
- [Post-Deployment Steps](#post-deployment-steps)
- [Troubleshooting](#troubleshooting)

## Overview

The application uses a multi-stage Docker build process that:
1. Builds the Next.js application
2. Generates Prisma Client
3. Creates an optimized production image
4. Pushes to GitHub Container Registry (GHCR)

Images are automatically built and pushed on:
- Push to `main` or `master` branch
- Push of version tags (e.g., `v1.0.0`)
- Manual workflow dispatch

## GitHub Actions CI/CD

### Automatic Image Building

When you push to the main branch, GitHub Actions will:
1. Build the Docker image using the production `Dockerfile`
2. Tag it with:
   - `latest` (for main branch)
   - Branch name (e.g., `main-abc1234`)
   - Semantic version (if tagged)
3. Push to `ghcr.io/<your-username>/<repository-name>`

### Image Tags

- `latest` - Latest build from main branch
- `main-<sha>` - Specific commit from main branch
- `v1.0.0` - Semantic version tags
- `v1.0` - Major.minor version tags

### Accessing Images

Images are available at:
```
ghcr.io/<your-username>/workadventure-universe-admin:latest
```

To pull an image:
```bash
docker pull ghcr.io/<your-username>/workadventure-universe-admin:latest
```

## Coolify Deployment

### Setting Up Coolify

1. **Create a new application** in Coolify
2. **Select "Docker Image"** as the source
3. **Set the image** to:
   ```
   ghcr.io/<your-username>/workadventure-universe-admin:latest
   ```
4. **Configure authentication** (if repository is private):
   - Username: Your GitHub username
   - Password: GitHub Personal Access Token (PAT) with `read:packages` permission

### Environment Variables

Set all required environment variables in Coolify:

#### Database Configuration
```env
DATABASE_URL=postgresql://user:password@postgres-host:5432/database_name
DB_USER=workadventure
DB_PASSWORD=your-secure-password
DB_NAME=workadventure_admin
```

#### Redis Configuration
```env
REDIS_URL=redis://redis-admin:6379
```

#### OIDC Configuration
```env
OIDC_ISSUER=https://your-oidc-provider.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
```

#### Application Configuration
```env
ADMIN_API_TOKEN=your-secure-token
NEXT_PUBLIC_API_URL=https://your-domain.com
NODE_ENV=production
PORT=3333
```

#### Optional Configuration
```env
MAP_STORAGE_API_TOKEN=your-token
PUBLIC_MAP_STORAGE_URL=https://map-storage.example.com
PLAY_URL=https://play.example.com
NEXT_PUBLIC_PLAY_URL=https://play.example.com
START_ROOM_URL=https://example.com/start.tmj
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### Container Port

Set the container port to **3333** in Coolify settings.

## Prisma Database Migrations

### Understanding Prisma in Production

The Prisma Client is **generated during the Docker build** process, so the image already contains the generated client. However, you still need to:

1. **Apply database migrations** to update the database schema
2. **Ensure migrations are up to date** before deploying new code

### Migration Strategy

#### Option 1: Pre-Deployment Migrations (Recommended)

Run migrations **before** deploying the new container:

```bash
# Connect to your database and run migrations
npx prisma migrate deploy
```

Or use a separate migration job/container that runs before the main application.

#### Option 2: Post-Deployment Migrations

Run migrations **after** the container starts using a startup script or init container.

### Running Migrations in Coolify

#### Method 1: Using Post-Deploy Command

In Coolify, you can set a **Post-Deploy Command**:

```bash
npx prisma migrate deploy
```

This runs after the container starts.

#### Method 2: Using a Startup Script

Create a startup script that runs migrations before starting the app:

```bash
#!/bin/sh
set -e

echo "Running database migrations..."
npx prisma migrate deploy

echo "Starting application..."
exec npm start
```

Then update your Dockerfile CMD to use this script.

#### Method 3: Manual Migration

SSH into your server and run:

```bash
# Get the container name
docker ps | grep workadventure-universe-admin

# Run migrations
docker exec <container-name> npx prisma migrate deploy
```

### Migration Commands

| Command | Use Case | Description |
|---------|----------|-------------|
| `prisma migrate deploy` | **Production** | Applies pending migrations safely |
| `prisma migrate dev` | Development only | Creates and applies migrations (can cause data loss) |
| `prisma generate` | Build time | Generates Prisma Client (already done in Docker build) |
| `prisma db push` | Development only | Pushes schema directly (bypasses migrations) |

### Important Notes

⚠️ **Never use `prisma migrate dev` in production** - it can cause data loss and is not safe for production databases.

✅ **Always use `prisma migrate deploy` in production** - it's safe, idempotent, and won't cause data loss.

### Checking Migration Status

To check if migrations are up to date:

```bash
docker exec <container-name> npx prisma migrate status
```

This shows:
- Which migrations have been applied
- Which migrations are pending
- Any issues with the database schema

## Post-Deployment Steps

### 1. Verify Database Connection

Check that the application can connect to the database:

```bash
docker logs <container-name> | grep -i "database\|prisma"
```

### 2. Verify Redis Connection

Check Redis connectivity:

```bash
docker logs <container-name> | grep -i "redis"
```

### 3. Check Application Health

Visit your application URL and check:
- `/api/capabilities` - Should return API capabilities
- `/admin/login` - Should show login page

### 4. Monitor Logs

Watch application logs for errors:

```bash
docker logs -f <container-name>
```

## Troubleshooting

### Build Fails in GitHub Actions

**Issue**: Build fails with Prisma or Next.js errors

**Solution**:
1. Check build logs in GitHub Actions
2. Ensure all dependencies are in `package.json`
3. Verify `Dockerfile` is correct
4. Check for TypeScript/build errors locally first

### Container Won't Start

**Issue**: Container exits immediately after starting

**Solution**:
1. Check logs: `docker logs <container-name>`
2. Verify all environment variables are set
3. Check database connectivity
4. Verify `DATABASE_URL` is correct

### Database Migration Errors

**Issue**: `prisma migrate deploy` fails

**Solution**:
1. Check database connection: `docker exec <container> npx prisma db pull`
2. Verify `DATABASE_URL` is correct
3. Check migration files exist: `ls prisma/migrations/`
4. Review migration status: `npx prisma migrate status`

### Prisma Client Errors

**Issue**: "Prisma Client not found" or schema mismatch

**Solution**:
1. The client is generated during build, so rebuild the image
2. If using a custom setup, run: `npx prisma generate`
3. Ensure `node_modules/.prisma` is copied in Dockerfile

### Redis Connection Errors

**Issue**: Cannot connect to Redis

**Solution**:
1. Verify `REDIS_URL` is correct
2. Check Redis service name (should be `redis-admin` if that's what you named it)
3. Ensure Redis is in the same Docker network
4. Test connection: `docker exec <container> sh -c 'echo "PING" | nc redis-admin 6379'`

## Best Practices

1. **Always test migrations locally** before deploying
2. **Use `prisma migrate deploy`** in production, never `migrate dev`
3. **Backup database** before running migrations
4. **Monitor logs** after deployment
5. **Use semantic versioning** for releases
6. **Tag images** with version numbers for rollback capability
7. **Keep environment variables** secure and never commit them

## Rollback Procedure

If you need to rollback:

1. **In Coolify**: Change the image tag to a previous version
   ```
   ghcr.io/<username>/workadventure-universe-admin:main-<previous-sha>
   ```

2. **Redeploy** the application

3. **If database migrations were applied**: You may need to manually revert them or restore from backup

## Additional Resources

- [Prisma Migration Guide](https://www.prisma.io/docs/guides/migrate)
- [Next.js Deployment](https://nextjs.org/docs/deployment)
- [Docker Best Practices](https://docs.docker.com/develop/dev-best-practices/)
- [Coolify Documentation](https://coolify.io/docs)

