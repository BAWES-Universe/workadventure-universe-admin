# Project structure and API overview

Moved from the main README. For every endpoint in full, see [ENDPOINTS.md](../ENDPOINTS.md).

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
- `GET /api/chat/person` - One person's name and Woka by chat ID (for chats with people outside the world)

See [docs/ENDPOINTS.md](../ENDPOINTS.md) for complete API documentation.
