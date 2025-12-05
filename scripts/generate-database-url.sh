#!/bin/bash
# Generate DATABASE_URL from DB_* environment variables
# Usage: 
#   source scripts/generate-database-url.sh  (for interactive use)
#   Or: eval $(scripts/generate-database-url.sh)  (for scripts)

# Load .env file if it exists
if [ -f .env ]; then
    # Source .env file to load variables
    set -a
    source <(cat .env | grep -v '^#' | grep -v '^$')
    set +a
fi

# Set defaults if not set
DB_USER=${DB_USER:-workadventure}
DB_PASSWORD=${DB_PASSWORD:-workadventure}
DB_NAME=${DB_NAME:-workadventure_admin}

# Detect if we're running from host or inside Docker
# If DB_HOST is not set, try to detect the environment
if [ -z "$DB_HOST" ]; then
    # Check if we're inside a Docker container
    if [ -f /.dockerenv ] || [ -n "$DOCKER_CONTAINER" ]; then
        DB_HOST="postgres"
    else
        # Running from host - use localhost
        DB_HOST="localhost"
    fi
fi

# Generate DATABASE_URL
DATABASE_URL="postgresql://${DB_USER}:${DB_PASSWORD}@${DB_HOST}:5432/${DB_NAME}"

# If script is sourced, export the variable
# If script is executed, output export command
if [ "${BASH_SOURCE[0]}" != "${0}" ]; then
    # Script is being sourced
    export DATABASE_URL
    echo "Generated DATABASE_URL: $DATABASE_URL" >&2
else
    # Script is being executed - output export command for eval
    echo "export DATABASE_URL=\"$DATABASE_URL\""
fi

