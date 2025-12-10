# Coolify Deployment Setup

Quick setup guide for deploying to Coolify using pre-built Docker images from GitHub Container Registry.

## Prerequisites

1. GitHub repository with GitHub Actions enabled
2. Coolify instance set up and running
3. Database (PostgreSQL) and Redis services available

## Step 1: Enable GitHub Actions

The GitHub Actions workflow (`.github/workflows/docker-build.yml`) will automatically build and push images to GHCR when you push to the main branch.

**First push to main will trigger the build.**

## Step 2: Create Application in Coolify

1. Go to your Coolify project
2. Click "New Resource" → "Application"
3. Select "Docker Image" as source
4. Enter image name:
   ```
   ghcr.io/<your-github-username>/workadventure-universe-admin:latest
   ```
   Replace `<your-github-username>` with your actual GitHub username.

## Step 3: Configure Authentication (if private repo)

If your repository is private, you need to authenticate:

1. In Coolify, go to your application settings
2. Add environment variable:
   - **Name**: `GHCR_TOKEN` (or similar)
   - **Value**: GitHub Personal Access Token with `read:packages` permission

Or configure Docker registry authentication in Coolify's registry settings.

## Step 4: Set Environment Variables

Configure all required environment variables in Coolify:

### Required Variables

```env
# Database
DATABASE_URL=postgresql://user:password@postgres-service:5432/workadventure_admin
DB_USER=workadventure
DB_PASSWORD=your-secure-password
DB_NAME=workadventure_admin

# Redis (use the service name you created)
REDIS_URL=redis://redis-admin:6379

# OIDC
OIDC_ISSUER=https://your-oidc-provider.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret

# Application
ADMIN_API_TOKEN=your-secure-token
NEXT_PUBLIC_API_URL=https://your-domain.com
NODE_ENV=production
PORT=3333
```

### Optional Variables

```env
MAP_STORAGE_API_TOKEN=your-token
PUBLIC_MAP_STORAGE_URL=https://map-storage.example.com
PLAY_URL=https://play.example.com
NEXT_PUBLIC_PLAY_URL=https://play.example.com
START_ROOM_URL=https://example.com/start.tmj
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

## Step 5: Configure Container Port

In Coolify application settings:
- **Port**: `3333`
- **Exposed Port**: `3333`

## Step 6: Configure Prisma Migrations

You have three options:

### Option A: Automatic Migrations (Recommended)

Update the Dockerfile to use the startup script:

1. Fork/clone the repository
2. Edit `Dockerfile` - change the last line from:
   ```dockerfile
   CMD ["npm", "start"]
   ```
   to:
   ```dockerfile
   CMD ["sh", "scripts/start.sh"]
   ```
3. Commit and push (this will rebuild the image)

### Option B: Post-Deploy Command

In Coolify, set **Post-Deploy Command**:
```bash
npx prisma migrate deploy
```

### Option C: Manual Migration

After deployment, run migrations manually:
```bash
# Get container name
docker ps | grep workadventure-universe-admin

# Run migrations
docker exec <container-name> npx prisma migrate deploy
```

## Step 7: Deploy

1. Click "Deploy" in Coolify
2. Wait for the container to start
3. Check logs for any errors

## Step 8: Verify Deployment

1. **Check container logs**:
   ```bash
   docker logs <container-name>
   ```

2. **Verify migrations**:
   ```bash
   docker exec <container-name> npx prisma migrate status
   ```

3. **Test endpoints**:
   - Visit: `https://your-domain.com/api/capabilities`
   - Should return JSON with API capabilities

## Updating the Application

When you push new code to the main branch:

1. GitHub Actions automatically builds a new image
2. Image is tagged as `latest` and pushed to GHCR
3. In Coolify, click "Redeploy" to pull the latest image
4. Migrations run automatically (if using startup script or post-deploy command)

## Troubleshooting

### Image Not Found

**Error**: `pull access denied` or `image not found`

**Solution**:
- Verify image name is correct: `ghcr.io/<username>/workadventure-universe-admin:latest`
- Check GitHub Actions ran successfully
- Verify repository is public or authentication is configured

### Container Won't Start

**Check logs**:
```bash
docker logs <container-name>
```

**Common issues**:
- Missing environment variables
- Database connection failed
- Wrong port configuration

### Migration Errors

**Run migrations manually**:
```bash
docker exec <container-name> npx prisma migrate deploy
```

**Check migration status**:
```bash
docker exec <container-name> npx prisma migrate status
```

### Redis Connection Failed

**Verify**:
- Redis service name matches `REDIS_URL` (e.g., `redis-admin`)
- Redis is in the same Docker network
- Redis is running: `docker ps | grep redis`

## Service Discovery

In Coolify, services can discover each other by service name:

- **Database**: Use the PostgreSQL service name (e.g., `postgres` or `postgres-admin`)
- **Redis**: Use the Redis service name (e.g., `redis-admin`)

Example `DATABASE_URL`:
```
postgresql://user:password@postgres-service:5432/database
```

Example `REDIS_URL`:
```
redis://redis-admin:6379
```

## Next Steps

- Read [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed deployment information
- Read [PRISMA-DEPLOYMENT.md](./PRISMA-DEPLOYMENT.md) for Prisma migration details
- Check [API-AUTHENTICATION.md](./API-AUTHENTICATION.md) for API setup

