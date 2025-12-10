# Fixing Prisma Schema Mismatch After Docker Compose Down/Up

## Problem

After running `docker compose down` and `docker compose up`, you may encounter errors like:

```
The column `(not available)` does not exist in the current database.
Invalid `prisma.room.findFirst()` invocation
```

This happens because:
1. The Prisma client gets out of sync with the database schema
2. Migrations may not have been applied
3. The Prisma client needs to be regenerated

## Quick Fix (Recommended)

Run this command for a complete fix (applies migrations, regenerates client, clears cache, restarts):

```bash
npm run db:fix
```

This runs the complete fix script that:
1. Applies database migrations
2. Regenerates Prisma client
3. Clears Next.js cache
4. Restarts the container

## Quick Fix (Fast - No Restart)

If you just need to regenerate the Prisma client without restarting:

```bash
npm run db:fix:quick
```

Or manually:

```bash
docker exec admin-api-dev sh -c 'cd /app && npx prisma migrate deploy && npx prisma generate'
```

**Note:** After the quick fix, you may need to wait for Next.js to recompile or restart the container manually.

## What It Does

1. **`prisma migrate deploy`**: Applies any pending migrations to sync the database schema
2. **`prisma generate`**: Regenerates the Prisma client to match the current schema

## Alternative: Using the Fix Script

You can also use the automated fix script:

```bash
npm run fix:prisma
```

This script:
- Detects if you're running on the host or inside Docker
- Applies migrations
- Regenerates the Prisma client
- Verifies everything is working

## Prevention

To avoid this issue in the future:

1. **Always run migrations before starting**: The `postinstall` script runs `prisma generate`, but you should also ensure migrations are applied
2. **Use `docker compose up` with health checks**: The docker-compose.yml includes health checks that wait for the database
3. **Consider adding a startup script**: You could add a script that runs migrations on container startup

## Manual Steps (if automated fix doesn't work)

If the automated fix doesn't work, try these steps:

1. **Check database connection**:
   ```bash
   docker exec admin-api-dev sh -c 'cd /app && npx prisma db pull'
   ```

2. **Reset and reapply migrations** (⚠️ WARNING: This deletes all data):
   ```bash
   npm run db:reset
   ```

3. **Or manually sync schema**:
   ```bash
   docker exec admin-api-dev sh -c 'cd /app && npx prisma db push'
   ```

## Related Commands

- `npm run db:migrate` - Create and apply a new migration
- `npm run db:migrate:deploy` - Apply pending migrations (production)
- `npm run db:generate` - Regenerate Prisma client only
- `npm run db:push` - Push schema changes directly (dev only)
- `npm run db:reset` - Reset database and reapply migrations (⚠️ deletes data)

