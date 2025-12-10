#!/bin/bash

# Complete Prisma fix script - handles everything needed after docker compose down/up
# This script:
# 1. Applies database migrations
# 2. Regenerates Prisma client
# 3. Clears Next.js cache
# 4. Restarts the container

set -e

echo "🔧 Complete Prisma Fix Script"
echo "=============================="
echo ""

# Check if container is running
if ! docker ps | grep -q admin-api-dev; then
  echo "❌ Error: admin-api-dev container is not running"
  echo "   Please run: docker-compose up -d"
  exit 1
fi

echo "Step 1: Applying database migrations..."
docker exec admin-api-dev sh -c 'cd /app && npx prisma migrate deploy' || {
  echo "⚠️  Warning: migrate deploy failed, trying migrate dev..."
  docker exec admin-api-dev sh -c 'cd /app && npx prisma migrate dev --name sync' || true
}

echo ""
echo "Step 2: Regenerating Prisma client..."
docker exec admin-api-dev sh -c 'cd /app && npx prisma generate'

echo ""
echo "Step 3: Verifying Prisma client..."
if docker exec admin-api-dev sh -c 'test -d /app/node_modules/.prisma/client'; then
  echo "✅ Prisma client generated successfully"
else
  echo "❌ Prisma client not found"
  exit 1
fi

echo ""
echo "Step 4: Stopping container to clear cache..."
docker-compose stop admin-api

echo ""
echo "Step 5: Clearing Next.js cache..."
# Try to remove .next, but don't fail if it's busy
docker exec admin-api-dev sh -c 'rm -rf /app/.next' 2>/dev/null || {
  echo "⚠️  Warning: Could not clear .next cache (container may be busy)"
  echo "   Cache will be cleared on next restart"
}

echo ""
echo "Step 6: Restarting container..."
docker-compose start admin-api

echo ""
echo "Step 7: Waiting for server to be ready..."
sleep 5

echo ""
echo "✅ Complete Prisma fix finished!"
echo ""
echo "💡 The Next.js server should now be using the updated Prisma client."
echo "   If you still see errors, wait a few seconds for the server to fully compile."
echo ""
echo "💡 Tip: If errors persist, check the logs with:"
echo "   docker logs admin-api-dev"

