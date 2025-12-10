#!/bin/bash

# Fix Prisma configuration issues after docker compose down/up
# This script fixes the common issue where Prisma client is out of sync with database schema

set -e

echo "🔧 Fixing Prisma configuration..."

# Check if we're in Docker or on host
if [ -f /.dockerenv ] || [ -n "$DOCKER_CONTAINER" ]; then
  echo "Running inside Docker container..."
  CONTAINER_MODE=false
else
  echo "Running on host, will execute commands in Docker container..."
  CONTAINER_MODE=true
fi

if [ "$CONTAINER_MODE" = true ]; then
  # Check if container is running
  if ! docker ps | grep -q admin-api-dev; then
    echo "❌ Error: admin-api-dev container is not running"
    echo "   Please run: docker-compose up -d"
    exit 1
  fi
  
  echo ""
  echo "1. Applying database migrations..."
  docker exec admin-api-dev sh -c 'cd /app && npx prisma migrate deploy' || {
    echo "⚠️  Warning: migrate deploy failed, trying migrate dev..."
    docker exec admin-api-dev sh -c 'cd /app && npx prisma migrate dev --name sync' || true
  }
  
  echo ""
  echo "2. Regenerating Prisma client..."
  docker exec admin-api-dev sh -c 'cd /app && npx prisma generate'
  
  echo ""
  echo "3. Verifying Prisma client..."
  if docker exec admin-api-dev sh -c 'test -d /app/node_modules/.prisma/client'; then
    echo "✅ Prisma client generated successfully"
  else
    echo "❌ Prisma client not found"
    exit 1
  fi
else
  # Running inside container
  echo ""
  echo "1. Applying database migrations..."
  npx prisma migrate deploy || {
    echo "⚠️  Warning: migrate deploy failed, trying migrate dev..."
    npx prisma migrate dev --name sync || true
  }
  
  echo ""
  echo "2. Regenerating Prisma client..."
  npx prisma generate
  
  echo ""
  echo "3. Verifying Prisma client..."
  if [ -d "node_modules/.prisma/client" ]; then
    echo "✅ Prisma client generated successfully"
  else
    echo "❌ Prisma client not found"
    exit 1
  fi
fi

echo ""
echo "✅ Prisma configuration fixed!"
echo ""
echo "💡 Tip: If you still see schema errors, try:"
echo "   npm run db:reset  (WARNING: This will delete all data!)"

