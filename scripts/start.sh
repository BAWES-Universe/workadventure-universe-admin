#!/bin/sh
set -e

# Production startup script
# Runs database migrations before starting the application

echo "🚀 Starting WorkAdventure Universe Admin..."

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "⚠️  WARNING: DATABASE_URL is not set. Migrations will be skipped."
else
  echo "📦 Running database migrations..."
  npx prisma migrate deploy || {
    echo "⚠️  WARNING: Migration failed. Continuing anyway..."
    echo "   You may need to run migrations manually:"
    echo "   docker exec <container> npx prisma migrate deploy"
  }
fi

echo "✅ Starting Next.js application..."
exec npx next start

