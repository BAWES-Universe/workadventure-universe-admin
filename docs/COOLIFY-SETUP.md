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

# Ready-made Apps run through Composio: they are on as soon as this is set, and absent without it (their routes answer 404).
# The key stays in Orbit; nothing else (bot server, computers, browser) ever holds it.
COMPOSIO_API_KEY=your-composio-api-key
# Brick computers run on Agent37: on as soon as this is set, and absent without it.
AGENT37_API_KEY=your-agent37-api-key
```

## Step 5: Configure Container Port

In Coolify application settings:
- **Port**: `3333`
- **Exposed Port**: `3333`

## Step 6: Prisma Migrations

Nothing to configure. The image's CMD (`sh scripts/start.sh`) applies every pending migration with
`prisma migrate deploy` and starts the app only when that succeeded. If a migration fails, the
container exits non-zero and Orbit does not start; see docs/PRISMA-DEPLOYMENT.md for recovering.

What happens when a migration fails depends on Coolify's health check:

- **Health check ON**: the new container never becomes healthy, so Coolify keeps the old container
  serving and marks the deploy failed. Nothing goes down. The old version then runs on a database where
  the release's earlier migrations did apply, so migrations must only add things (new tables, nullable
  or defaulted columns) and never rename or drop what the old code uses. (This relies on Coolify's
  rolling update: no fixed host port mapping and no custom container name.)
- **Health check OFF**: Coolify waits a fixed few seconds and removes the old container anyway, so a
  failed migration means Orbit is **down** until a fixed image is deployed. The new container exits
  and Docker restarts it in a loop (each attempt refuses again; it changes nothing).

The app does not listen until the migrations have finished, so the health check's start period must be
longer than the longest migration. If Coolify gives up first, it removes the new container in the middle
of a migration, which is then usually committed by Postgres but recorded as failed by Prisma (see
docs/PRISMA-DEPLOYMENT.md, "Troubleshooting"). With the check off, a long migration is a gap with
nothing serving.

Health check settings (turn the check ON before deploying an image that migrates at start):

| Setting | Value |
| --- | --- |
| Method / path | `GET /admin` (not `/`: `/` answers 307 to `/admin`; `/admin` answers 200 without the database) |
| Expected code | `200` |
| Host / port | `127.0.0.1` / `3333` |
| Start period | `120` s (60 s at the very least) |
| Interval / retries | 5 to 10 s / 3 or more |

`next start` is given no `-H`, so Node listens on every address (`::`, which also accepts IPv4, or
`0.0.0.0` where the host has no IPv6): `127.0.0.1` always reaches it, while `localhost` can resolve to
`::1` on some hosts. The image has busybox `wget` and no `curl`, which Coolify's check falls back to.

Do not configure a post-deploy migration command (`npx prisma migrate deploy`): the container
already applies migrations at startup, a post-deploy hook only runs after the new code is serving, and
`npx` is not a pinned path to the Prisma CLI bundled in the image. If one is set today, drop it after the
first good deploy of an image that migrates at start; until then it finds nothing pending (if it ever
overlapped a running migration, it would wait on Prisma's database lock and fail without changing
anything).

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
   docker exec <container-name> node node_modules/prisma/build/index.js migrate status
   ```

3. **Test endpoints**:
   - Visit: `https://your-domain.com/api/capabilities`
   - Should return JSON with API capabilities

## Updating the Application

When you push new code to the main branch:

1. GitHub Actions automatically builds a new image
2. Image is tagged as `latest` and pushed to GHCR
3. In Coolify, click "Redeploy" to pull the latest image
4. Migrations run automatically when the new container starts; if they fail, it does not start

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

The container applies migrations itself every time it starts, so there is nothing to run by hand. If they
fail, its log ends with `Orbit is NOT starting`. With the health check OFF the container then stops (or
keeps restarting) and Orbit is down; with it ON, Coolify removes it and the old version keeps serving.
`docker exec` cannot reach the failed container either way. Check and resolve from a one-off container of the
same image instead: the commands are in docs/PRISMA-DEPLOYMENT.md under "Troubleshooting".

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

