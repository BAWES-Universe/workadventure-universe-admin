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
- PostgreSQL database
- WorkAdventure instance running (for OIDC mock in development)

### Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Set up environment variables:**
   ```bash
   cp .env.example .env.local
   ```
   
   Edit `.env.local` with your configuration:
   - `ADMIN_API_TOKEN` - Must match WorkAdventure's ADMIN_API_TOKEN
   - `OIDC_ISSUER` - OIDC provider URL (use WorkAdventure's OIDC mock for dev)
   - `DATABASE_URL` - PostgreSQL connection string

3. **Set up database:**
   ```bash
   # Start PostgreSQL (using docker-compose)
   docker-compose up -d postgres
   
   # Generate Prisma Client
   npx prisma generate
   
   # Run migrations
   npx prisma migrate dev --name init
   ```

4. **Start development server:**
   ```bash
   npm run dev
   ```

The API will be available at `http://localhost:3000`.

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

```bash
# Generate Prisma Client after schema changes
npx prisma generate

# Create a new migration
npx prisma migrate dev --name migration-name

# View database in Prisma Studio
npx prisma studio
```

### Testing

Test endpoints using curl:

```bash
# Test capabilities endpoint
curl -H "Authorization: Bearer your-token" \
  http://localhost:3000/api/capabilities

# Test map endpoint
curl -H "Authorization: Bearer your-token" \
  "http://localhost:3000/api/map?playUri=http://play.workadventure.localhost/@/universe/world/room"
```

## Documentation

- [SETUP.md](./docs/SETUP.md) - Complete setup guide
- [ENDPOINTS.md](./docs/ENDPOINTS.md) - API endpoint reference
- [DATABASE.md](./docs/DATABASE.md) - Database schema documentation
- [AUTHENTICATION.md](./docs/AUTHENTICATION.md) - Authentication guide
- [DATA-TYPES.md](./docs/DATA-TYPES.md) - Type definitions

## Deployment

See [docs/SETUP.md](./docs/SETUP.md#production-deployment) for deployment instructions.

## License

[Add your license here]
