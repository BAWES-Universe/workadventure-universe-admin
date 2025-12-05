#!/bin/bash
# Generate DATABASE_URL from DB_* environment variables
# Usage: source scripts/generate-database-url.sh
# Then use $DATABASE_URL in your commands

# Load .env file if it exists
if [ -f .env ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

# Set defaults if not set
DB_USER=${DB_USER:-workadventure}
DB_PASSWORD=${DB_PASSWORD:-workadventure}
DB_NAME=${DB_NAME:-workadventure_admin}
DB_HOST=${DB_HOST:-postgres}

# Generate DATABASE_URL
export DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:5432/${DB_NAME}"

echo "Generated DATABASE_URL: $DATABASE_URL"

