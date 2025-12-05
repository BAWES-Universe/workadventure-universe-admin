# WorkAdventure Admin API - Next.js Implementation Guide

This folder contains comprehensive documentation for implementing a Next.js Admin API that integrates seamlessly with WorkAdventure.

## 📋 Table of Contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Quick Start](#quick-start)
- [Documentation Files](#documentation-files)
- [Key Concepts](#key-concepts)

## Overview

The Admin API is an **optional** component that allows you to:

- Connect WorkAdventure to your own database (using Prisma ORM)
- Manage users and their privileges (tags)
- Create universes, worlds, and rooms dynamically
- Implement custom authentication flows
- Control access to maps, worlds, and universes
- Manage user avatars (Wokas) and companions
- Handle user reporting and banning
- Integrate with your existing user management system
- Enable universe/world/room discovery (Habbo-like)
- Support social features (favorites, follows, friends, teleportation)

## Architecture

```
┌─────────────┐         ┌──────────────┐         ┌─────────────┐
│   Frontend  │────────▶│    Pusher    │────────▶│  Admin API  │
│  (Browser)  │         │  (WorkAdventure)      │  (Your API)  │
└─────────────┘         └──────────────┘         └─────────────┘
                              │
                              ▼
                        ┌─────────────┐
                        │     Back    │
                        │  (WorkAdventure) │
                        └─────────────┘
```

**Important**: The Admin API is called **by** WorkAdventure (Pusher service), not the other way around. WorkAdventure makes HTTP requests to your API when it needs user data, map information, or authorization.

## Quick Start

1. **Read the documentation**:
   - Start with [SETUP.md](./docs/SETUP.md) for Next.js setup instructions
   - Review [ENDPOINTS.md](./docs/ENDPOINTS.md) for all required endpoints
   - Check [AUTHENTICATION.md](./docs/AUTHENTICATION.md) for security requirements

2. **Configure WorkAdventure**:
   ```env
   ADMIN_API_URL=http://your-api.com
   ADMIN_API_TOKEN=your-secret-token
   ```

3. **Set up database**:
   - Review [DATABASE.md](./docs/DATABASE.md) for the Prisma schema
   - Initialize Prisma and run migrations
   - Set up your database connection

4. **Implement endpoints**:
   - Start with the core endpoints: `/api/map`, `/api/room/access`, `/api/woka/list`
   - Add optional endpoints as needed based on your requirements

5. **Test your implementation**:
   - Use the examples in [EXAMPLES.md](./docs/EXAMPLES.md)
   - Verify against the Swagger documentation at `https://play.workadventu.re/swagger-ui/`

## Documentation Files

| File | Description |
|------|-------------|
| [SETUP.md](./docs/SETUP.md) | Next.js setup guide, project structure, and configuration |
| [ENDPOINTS.md](./docs/ENDPOINTS.md) | Complete list of all required and optional API endpoints |
| [AUTHENTICATION.md](./docs/AUTHENTICATION.md) | Authentication, security, and token validation |
| [DATA-TYPES.md](./docs/DATA-TYPES.md) | All TypeScript interfaces and data schemas |
| [DATABASE.md](./docs/DATABASE.md) | Database schema and Prisma setup guide |
| [EXAMPLES.md](./docs/EXAMPLES.md) | Example implementations and code snippets |
| [OIDC-INTEGRATION.md](./docs/OIDC-INTEGRATION.md) | OIDC authentication integration guide |

## Key Concepts

### 1. Bearer Token Authentication

All requests from WorkAdventure include a Bearer token in the `Authorization` header:
```
Authorization: your-admin-api-token
```

This token is set via the `ADMIN_API_TOKEN` environment variable in WorkAdventure.

### 2. User Identifiers

User identifiers can be:
- UUIDs (e.g., `998ce839-3dea-4698-8b41-ebbdf7688ad9`)
- Email addresses (e.g., `user@example.com`)
- OIDC subject IDs

Your API should handle all these formats.

### 3. Play URI Format

Play URIs follow this pattern:
```
http://play.workadventure.localhost/@/universeSlug/worldSlug/roomSlug
```

Your API needs to parse these URIs to extract:
- Universe identifier (user-created spaces that contain worlds)
- World identifier (contained within a universe)
- Room identifier (contained within a world)

**Note:** In this implementation, all users can create universes, which contain worlds, which contain rooms. This enables a Habbo-like discovery system where users can explore and navigate between universes, worlds, and rooms.

### 4. Capabilities System

WorkAdventure checks for API capabilities at startup. Implement `/api/capabilities` to advertise which optional endpoints you support.

### 5. Error Handling

Always return proper HTTP status codes:
- `200` - Success
- `204` - Success (no content)
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not found
- `500` - Internal server error

Use the error response format defined in [DATA-TYPES.md](./docs/DATA-TYPES.md).

## Development Workflow

### Local Development

For local development, you can use the OIDC mock server that comes with WorkAdventure:

```env
# In your Next.js .env.local
OIDC_ISSUER=http://oidc.workadventure.localhost
OIDC_CLIENT_ID=authorization-code-client-id
OIDC_CLIENT_SECRET=authorization-code-client-secret
```

### Production

In production, configure your API to use your Authentik instance:

```env
OIDC_ISSUER=https://authentik.yourdomain.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
```

## Next Steps

1. Read [SETUP.md](./docs/SETUP.md) to set up your Next.js project
2. Review [DATABASE.md](./docs/DATABASE.md) for the Prisma schema and set up your database
3. Implement the core endpoints from [ENDPOINTS.md](./docs/ENDPOINTS.md)
4. Test your implementation using [EXAMPLES.md](./docs/EXAMPLES.md)
5. Deploy and configure WorkAdventure to use your API

## Universe/World/Room Structure

This implementation uses a **Universe** structure where:
- **Universe**: User-created top-level container (replaces "team" in standard WorkAdventure)
- **World**: Belongs to a universe, contains multiple rooms
- **Room**: Belongs to a world, the actual playable space

All users can create universes, enabling:
- Universe discovery (browse all universes)
- World discovery (browse worlds within a universe)
- Room discovery (browse rooms within a world)
- Social features (favorites, follows, friends, teleportation) - planned

See [DATABASE.md](./docs/DATABASE.md) for the complete data model.

## Support

- WorkAdventure Documentation: https://workadventu.re/
- Swagger API Documentation: https://play.workadventu.re/swagger-ui/
- GitHub Issues: https://github.com/thecodingmachine/workadventure/issues

## License

This documentation is provided as-is. WorkAdventure is licensed under AGPL-3.0 with Commons Clause restrictions.

