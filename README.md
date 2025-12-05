# WorkAdventure Universe Admin API

A Next.js Admin API for WorkAdventure that provides user management, room access control, and moderation features.

## Overview

This Admin API integrates with WorkAdventure to provide:
- User authentication and authorization via OIDC
- Room and world access control
- Member management
- Woka (avatar) and companion management
- Ban and moderation features
- Chat member directory

## Getting Started

### Prerequisites

- Node.js 18+ and npm/yarn/pnpm
- Docker and Docker Compose
- WorkAdventure instance running (for OIDC mock in development)

### Setup

1. **Configure hosts file** (required for local development):
   
   Add the following entries to your hosts file to enable local domain routing:
   
   **Linux/macOS** (`/etc/hosts`):
   ```bash
   sudo nano /etc/hosts
   ```
   
   **Windows** (`C:\Windows\System32\drivers\etc\hosts` - run as Administrator):
   ```powershell
   notepad C:\Windows\System32\drivers\etc\hosts
   ```
   
   Add these lines:
   ```
   127.0.0.1    admin.bawes.localhost
   127.0.0.1    traefik-admin.bawes.localhost
   ```
   
   **Note**: If you're using WorkAdventure's OIDC mock, you may also need:
   ```
   127.0.0.1    oidc.workadventure.localhost
   127.0.0.1    play.workadventure.localhost
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` with your configuration:
   - `DB_USER`, `DB_PASSWORD`, `DB_NAME` - Database credentials
   - `ADMIN_API_TOKEN` - Must match WorkAdventure's ADMIN_API_TOKEN
   - `OIDC_ISSUER` - OIDC provider URL (use WorkAdventure's OIDC mock for dev)
   - `DATABASE_URL` - PostgreSQL connection string (auto-constructed from DB_* vars in Docker)

4. **Start services with Docker Compose:**
   ```bash
   docker-compose up
   ```
   
   This will start:
   - PostgreSQL database
   - Admin API (Next.js) behind Traefik
   - Traefik reverse proxy

5. **Initialize database:**
   ```bash
   # Run migrations (from inside the container or using npm scripts)
   docker compose exec admin-api npx prisma migrate dev --name init
   
   # Or use the npm script (from host)
   npm run db:migrate
   ```

The Admin API will be available at:
- **Admin Interface**: http://admin.bawes.localhost:8321
- **Traefik Dashboard**: http://traefik-admin.bawes.localhost:8321

**Note**: Port `8321` is required as Traefik is configured to run on this port (configurable via `TRAEFIK_PORT` in `.env`).

## Admin Interface

This project includes a web-based admin interface for managing universes, worlds, rooms, and users.

### Accessing the Admin Interface

1. **Start services**:
   ```bash
   docker-compose up
   ```

2. **Access the admin interface**:
   - Go to http://admin.bawes.localhost:8321/admin/login
   - Get an OIDC access token from WorkAdventure (see [OIDC Authentication Testing](./docs/testing/oidc-authentication.md))
   - Paste the token and sign in

3. **Alternative: Admin Token** (for API testing):
   - API endpoints can use `ADMIN_API_TOKEN` for direct access
   - Web interface uses OIDC sessions for user-specific content

4. **View Traefik dashboard** (optional):
   - Go to http://traefik-admin.bawes.localhost:8321 to see routing information

### Admin Features

- **Dashboard**: Overview of all entities with statistics
- **Universes**: Create and manage universes (top-level containers)
- **Worlds**: Create and manage worlds within universes
- **Rooms**: Create and manage rooms within worlds
- **Users**: View and manage users

See [Admin Interface Guide](./docs/admin/guide.md) for complete documentation on using the admin interface.

## Project Structure

```
├── app/
│   └── api/              # API route handlers
│       ├── capabilities/ # API capabilities endpoint
│       ├── map/          # Map details endpoint
│       ├── room/         # Room access and management
│       ├── members/      # Member management
│       ├── woka/         # Avatar management
│       ├── companion/    # Companion management
│       ├── ban/          # Ban management
│       ├── report/       # User reporting
│       └── chat/         # Chat member directory
├── lib/
│   ├── auth.ts          # Bearer token validation
│   ├── oidc.ts          # OIDC client and token validation
│   ├── db.ts            # Prisma client instance
│   └── utils.ts         # Utility functions
├── prisma/
│   └── schema.prisma    # Database schema
├── types/
│   └── workadventure.ts # TypeScript type definitions
└── schemas/
    └── workadventure.ts  # Zod validation schemas
```

## API Endpoints

### Core Endpoints

- `GET /api/capabilities` - Returns supported API capabilities
- `GET /api/map` - Maps Play URI to map details
- `GET /api/room/access` - Returns member information and access permissions

### Member Endpoints

- `GET /api/members` - Search for members
- `GET /api/members/[memberUUID]` - Get member details

### Woka & Companion Endpoints

- `GET /api/woka/list` - Get available Wokas (avatars)
- `GET /api/companion/list` - Get available companions

### Moderation Endpoints

- `GET /api/ban` - Check if user is banned
- `POST /api/ban` - Ban a user
- `POST /api/report` - Report a user

### Room Endpoints

- `GET /api/room/sameWorld` - Get all rooms in the same world
- `GET /api/room/tags` - Get all tags used in a room

### Chat Endpoints

- `GET /api/chat/members` - Get list of members for chat

See [docs/ENDPOINTS.md](./docs/ENDPOINTS.md) for complete API documentation.

## Configuration

### Environment Variables

Required:
- `ADMIN_API_TOKEN` - Bearer token for API authentication
- `OIDC_ISSUER` - OIDC provider URL
- `OIDC_CLIENT_ID` - OIDC client ID
- `OIDC_CLIENT_SECRET` - OIDC client secret
- `DATABASE_URL` - PostgreSQL connection string

Optional:
- `REDIS_URL` - Redis connection (for caching/rate limiting)
- `NODE_ENV` - Environment (development/production)
- `LOG_LEVEL` - Logging level

## Development

### Database Management

All Prisma commands run inside the Docker container to ensure compatibility with Prisma 7 (requires Node.js 20.19+ or 22.12+).

```bash
# Generate Prisma Client after schema changes
npm run db:generate

# Create a new migration
npm run db:migrate

# Deploy migrations (production)
npm run db:migrate:deploy

# Push schema changes directly to database (dev only)
npm run db:push

# Reset database (drops all data and runs migrations)
npm run db:reset

# View database in Prisma Studio
npm run db:studio
```

#### Prisma Studio

Prisma Studio provides a visual database browser. It runs on-demand (not automatically with `docker-compose up`).

**Usage:**
1. Start your services:
   ```bash
   docker-compose up
   ```

2. In a separate terminal, start Prisma Studio:
   ```bash
   npm run db:studio
   ```

3. Open your browser and navigate to:
   ```
   http://localhost:5555
   ```

4. Stop Prisma Studio by pressing `Ctrl+C` in the terminal where it's running.

**Note:** Port 5555 is exposed in `docker-compose.yml` to make Prisma Studio accessible from your host machine. The Studio runs inside the `admin-api-dev` container and connects to the PostgreSQL database using the `DATABASE_URL` environment variable configured in the container.

### Testing

#### Authentication Overview

This API uses **Bearer token authentication**. All requests must include the `ADMIN_API_TOKEN` in the Authorization header:

```
Authorization: Bearer {ADMIN_API_TOKEN}
```

**Important**: The `ADMIN_API_TOKEN` must match the token configured in your WorkAdventure instance. This is a shared secret between WorkAdventure and your Admin API.

#### Getting Your Token

1. **Check your `.env.local` file**:
   ```bash
   cat .env.local | grep ADMIN_API_TOKEN
   ```

2. **If not set, add it**:
   ```env
   ADMIN_API_TOKEN=your-secret-token-here-change-in-production
   ```

3. **Make sure WorkAdventure uses the same token**:
   - In WorkAdventure's environment variables, set:
     ```env
     ADMIN_API_TOKEN=your-secret-token-here-change-in-production
     ADMIN_API_URL=http://admin.bawes.localhost:8321
     ```

#### Testing with cURL

```bash
# Set your token as a variable (replace with your actual token)
export TOKEN="your-secret-token-here-change-in-production"
BASE_URL="http://admin.bawes.localhost:8321"

# Test capabilities endpoint
curl -H "Authorization: Bearer $TOKEN" \
  $BASE_URL/api/capabilities

# Test map endpoint
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/map?playUri=http://play.workadventure.localhost/@/universe/world/room"

# Test room access endpoint
curl -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/room/access?userIdentifier=test-user&playUri=http://play.workadventure.localhost/@/universe/world/room&ipAddress=127.0.0.1"

# Test without token (should return 401)
curl $BASE_URL/api/capabilities
```

#### Testing with Postman

1. **Create a new request**
2. **Set the URL**: `http://admin.bawes.localhost:8321/api/capabilities`
3. **Go to the "Authorization" tab**
4. **Select "Bearer Token" type**
5. **Enter your token**: `your-secret-token-here-change-in-production`
6. **Send the request**

You can also set the token in the Headers tab:
- Key: `Authorization`
- Value: `Bearer your-secret-token-here-change-in-production`

#### Testing with WorkAdventure Integration

1. **Ensure WorkAdventure is configured**:
   ```env
   ADMIN_API_URL=http://admin.bawes.localhost
   ADMIN_API_TOKEN=your-secret-token-here-change-in-production
   ```
   
   **Note**: Since both services run behind Traefik, WorkAdventure can access the Admin API via the domain name if both are on the same network, or via the Traefik port if needed.

2. **Start WorkAdventure** (if not already running)

3. **Access a room** in WorkAdventure:
   - Open `http://play.workadventure.localhost/@/universe/world/room`
   - WorkAdventure will automatically call your Admin API endpoints

4. **Check your API logs** to see incoming requests:
   ```bash
   # View logs from Docker
   docker-compose logs -f admin-api
   
   # Or if running on host, your Next.js dev server will show logs like:
   # GET /api/map 200 in 45ms
   # GET /api/room/access 200 in 23ms
   ```

#### Quick Test Script

Create a test script to verify all endpoints:

```bash
#!/bin/bash
# test-api.sh

TOKEN="${ADMIN_API_TOKEN:-your-secret-token-here-change-in-production}"
BASE_URL="http://admin.bawes.localhost:8321"

echo "Testing Admin API with token: $TOKEN"
echo ""

# Test capabilities
echo "1. Testing /api/capabilities..."
curl -s -H "Authorization: Bearer $TOKEN" "$BASE_URL/api/capabilities" | jq .
echo ""

# Test map (adjust playUri as needed)
echo "2. Testing /api/map..."
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/map?playUri=http://play.workadventure.localhost/@/universe/world/room" | jq .
echo ""

# Test room access
echo "3. Testing /api/room/access..."
curl -s -H "Authorization: Bearer $TOKEN" \
  "$BASE_URL/api/room/access?userIdentifier=test-user&playUri=http://play.workadventure.localhost/@/universe/world/room&ipAddress=127.0.0.1" | jq .
echo ""

echo "Done!"
```

Save as `test-api.sh`, make it executable (`chmod +x test-api.sh`), and run it.

#### Common Issues

**401 Unauthorized**:
- Check that `ADMIN_API_TOKEN` is set in `.env.local`
- Verify the token in the Authorization header matches exactly
- Ensure there are no extra spaces in the token

**Connection Refused**:
- Make sure services are running: `docker-compose ps`
- Check the API is accessible at `http://admin.bawes.localhost:8321`
- Verify hosts file is configured correctly (see Setup step 1)
- Check Traefik is running: `docker-compose logs traefik`

**Token Mismatch with WorkAdventure**:
- Ensure both WorkAdventure and Admin API use the same `ADMIN_API_TOKEN`
- Restart both services after changing the token

## Docker Setup

This project includes two Dockerfiles for different use cases:

### Development Dockerfile (`Dockerfile.dev`)

Used by `docker-compose.yml` for local development. Features:
- Hot reload with volume mounts
- Development dependencies included
- Runs Next.js dev server (`npm run dev`)
- Accessible via Traefik at `admin.bawes.localhost:8321`

**Usage:**
```bash
# Build and start (via docker-compose)
docker-compose up -d

# Or build manually
docker build -f Dockerfile.dev -t admin-api:dev .
```

**Key Features:**
- Installs all dependencies (including dev dependencies)
- Skips `postinstall` scripts during build to avoid Prisma generate issues
- Generates Prisma Client by temporarily renaming `prisma.config.ts` (avoids DATABASE_URL requirement during build)
- Volume mounts for live code changes
- Exposes port 3333 for Traefik routing

### Production Dockerfile (`Dockerfile`)

Multi-stage build optimized for production deployment. Features:
- Smaller final image (production dependencies only)
- Code baked into image (no volume mounts)
- Runs Next.js production server (`npm start`)
- Optimized build layers for caching

**Usage:**
```bash
# Build production image
docker build -t admin-api:prod .

# Run with environment variables
docker run -p 3333:3333 \
  --env-file .env \
  -e DATABASE_URL="postgresql://user:pass@host:5432/db" \
  admin-api:prod
```

**Build Stages:**
1. **deps**: Installs production dependencies only
2. **builder**: Installs all dependencies, generates Prisma Client, builds Next.js app
3. **runner**: Minimal runtime image with only production files

**Key Features:**
- Uses `npm ci` for faster, reproducible builds
- Multi-stage build reduces final image size
- Prisma Client generated during build (bypasses config file requirement)
- Production-optimized Next.js build
- Only includes necessary runtime files

**Note:** The production Dockerfile requires all code to compile successfully. If you encounter build errors, fix them before deploying.

### Docker Compose

The `docker-compose.yml` file orchestrates the development environment:

**Services:**
- `postgres`: PostgreSQL 15 database
- `admin-api`: Admin API service (uses `Dockerfile.dev`)
- `traefik`: Reverse proxy for routing

**Configuration:**
- Database credentials configurable via `.env` (`DB_USER`, `DB_PASSWORD`, `DB_NAME`)
- Traefik dashboard at `traefik-admin.bawes.localhost:8321`
- Admin API accessible at `admin.bawes.localhost:8321`

**Commands:**
```bash
# Start all services
docker-compose up -d

# View logs
docker-compose logs -f admin-api

# Stop services
docker-compose down

# Rebuild after changes
docker-compose build admin-api
docker-compose up -d
```

## Documentation

### Core Documentation
- [Setup Guide](./docs/SETUP.md) - Complete setup guide
- [API Endpoints](./docs/ENDPOINTS.md) - API endpoint reference
- [Database Schema](./docs/DATABASE.md) - Database schema documentation
- [Authentication](./docs/AUTHENTICATION.md) - Authentication guide
- [Data Types](./docs/DATA-TYPES.md) - Type definitions
- [Examples](./docs/EXAMPLES.md) - Code examples

### Development
- [Development Workflow](./docs/development/workflow.md) - Complete automated development workflow
- [Troubleshooting](./docs/development/troubleshooting.md) - Common issues and solutions

### Testing
- [Testing Guide](./docs/testing/README.md) - Complete testing documentation
- [Manual Testing](./docs/testing/manual-testing.md) - Manual testing procedures
- [OIDC Authentication Testing](./docs/testing/oidc-authentication.md) - OIDC-specific testing
- [Integration Tests](./docs/testing/integration-tests.md) - Automated integration testing with WorkAdventure

### Admin Interface
- [Admin Interface Guide](./docs/admin/guide.md) - Complete admin interface documentation

## Deployment

See [docs/SETUP.md](./docs/SETUP.md#production-deployment) for deployment instructions.

