#!/bin/bash

# Fix Prisma configuration issues

echo "🔧 Fixing Prisma configuration..."

# Regenerate Prisma client
echo "1. Regenerating Prisma client..."
npx prisma generate

# Check if DATABASE_URL is set
if [ -z "$DATABASE_URL" ]; then
  echo "⚠️  Warning: DATABASE_URL not set"
  echo "   Make sure to set it in .env.local"
fi

# Verify Prisma client
echo "2. Verifying Prisma client..."
if [ -d "node_modules/.prisma/client" ]; then
  echo "✅ Prisma client generated successfully"
else
  echo "❌ Prisma client not found"
  exit 1
fi

echo "✅ Prisma configuration fixed!"

