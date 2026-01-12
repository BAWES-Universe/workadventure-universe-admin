# Bot API Response Format - Frontend Developer Guide

## Overview

All Bot API endpoints now include audit trail information (created/updated timestamps and user information) in their responses.

## Response Structure

### Bot Object

Every bot object in API responses includes the following fields:

```typescript
interface Bot {
  // Core fields
  id: string;
  roomId: string;
  name: string;
  description: string | null;
  characterTextureId: string | null;
  enabled: boolean;
  behaviorType: 'idle' | 'patrol' | 'social';
  behaviorConfig: {
    assignedSpace?: {
      center: { x: number; y: number };
      radius: number;
    };
    patrolWaypoints?: Array<{ x: number; y: number }>;
    conversationRadius?: number;
    minTimeBetweenConversations?: number;
  };
  chatInstructions: string | null;
  movementInstructions: string | null;
  aiProviderRef: string | null;
  
  // Timestamps (ISO 8601 format)
  createdAt: string;  // e.g., "2026-01-06T12:00:00.000Z"
  updatedAt: string;  // e.g., "2026-01-06T14:30:00.000Z"
  
  // Audit trail - User information (may be null for bots created before this feature)
  createdBy: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
  
  updatedBy: {
    id: string;
    name: string | null;
    email: string | null;
  } | null;
  
  // Room relation (included in all responses)
  room: {
    id: string;
    worldId: string;
    slug: string;
    name: string;
    description: string | null;
    mapUrl: string | null;
    wamUrl: string | null;
    isPublic: boolean;
    createdAt: string;
    updatedAt: string;
  };
}
```

## API Endpoints

### GET /api/bots?roomId={roomId}

**Response:** Array of bot objects

```json
[
  {
    "id": "123e4567-e89b-12d3-a456-426614174000",
    "roomId": "room-uuid-here",
    "name": "Greeter Bot",
    "description": "Welcomes visitors",
    "characterTextureId": "male1",
    "enabled": true,
    "behaviorType": "social",
    "behaviorConfig": {
      "assignedSpace": {
        "center": { "x": 320, "y": 480 },
        "radius": 150
      },
      "conversationRadius": 100,
      "minTimeBetweenConversations": 60000
    },
    "chatInstructions": "You are a friendly greeter...",
    "movementInstructions": "Welcome visitors in the lobby...",
    "aiProviderRef": null,
    "createdAt": "2026-01-06T12:00:00.000Z",
    "updatedAt": "2026-01-06T12:00:00.000Z",
    "createdBy": {
      "id": "user-uuid-here",
      "name": "John Doe",
      "email": "john@example.com"
    },
    "updatedBy": {
      "id": "user-uuid-here",
      "name": "John Doe",
      "email": "john@example.com"
    },
    "room": {
      "id": "room-uuid-here",
      "worldId": "world-uuid-here",
      "slug": "lobby",
      "name": "Main Lobby",
      "description": "Welcome area",
      "mapUrl": "https://example.com/map.tmj",
      "wamUrl": null,
      "isPublic": true,
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  }
]
```

### GET /api/bots/:id

**Response:** Single bot object (same structure as above)

### POST /api/bots

**Request Body:** (same as before, no changes needed)

**Response:** Created bot object with audit fields populated

```json
{
  "id": "new-bot-uuid",
  "roomId": "room-uuid-here",
  "name": "New Bot",
  // ... other fields ...
  "createdAt": "2026-01-06T15:30:00.000Z",
  "updatedAt": "2026-01-06T15:30:00.000Z",
  "createdBy": {
    "id": "current-user-uuid",
    "name": "Current User",
    "email": "user@example.com"
  },
  "updatedBy": {
    "id": "current-user-uuid",
    "name": "Current User",
    "email": "user@example.com"
  },
  "room": { /* ... */ }
}
```

### PUT /api/bots/:id

**Request Body:** (partial updates allowed, same as before)

**Response:** Updated bot object with `updatedBy` reflecting the user who made the change

```json
{
  "id": "bot-uuid",
  // ... updated fields ...
  "updatedAt": "2026-01-06T16:45:00.000Z",
  "createdBy": {
    "id": "original-creator-uuid",
    "name": "Original Creator",
    "email": "creator@example.com"
  },
  "updatedBy": {
    "id": "current-user-uuid",
    "name": "Current User",
    "email": "user@example.com"
  },
  "room": { /* ... */ }
}
```

## Display Guidelines

### Timestamps

- **Format:** ISO 8601 strings (e.g., `"2026-01-06T15:30:00.000Z"`)
- **Display:** Format for user's locale/timezone
- **Examples:**
  - "Created: January 6, 2026 at 3:30 PM"
  - "Last updated: 2 hours ago"
  - "Created: 2026-01-06 15:30"

### User Information

- **createdBy:** The user who created the bot
- **updatedBy:** The user who last modified the bot
- **Null handling:** Both fields may be `null` for bots created before this feature was added

### Display Examples

```typescript
// Display creation info
function formatBotMetadata(bot: Bot) {
  const created = bot.createdBy 
    ? `Created by ${bot.createdBy.name || bot.createdBy.email} on ${formatDate(bot.createdAt)}`
    : `Created on ${formatDate(bot.createdAt)}`;
  
  const updated = bot.updatedBy && bot.updatedBy.id !== bot.createdBy?.id
    ? `Last updated by ${bot.updatedBy.name || bot.updatedBy.email} on ${formatDate(bot.updatedAt)}`
    : `Last updated on ${formatDate(bot.updatedAt)}`;
  
  return { created, updated };
}

// Display in UI
<div className="bot-metadata">
  <p>{formatBotMetadata(bot).created}</p>
  <p>{formatBotMetadata(bot).updated}</p>
</div>
```

## Important Notes

1. **Backward Compatibility:** Bots created before this feature was added will have `createdBy` and `updatedBy` as `null`. Always check for null before accessing these fields.

2. **Timestamps:** Both `createdAt` and `updatedAt` are always present and reliable (handled automatically by the database).

3. **User Identification:** User information is extracted from OIDC tokens, so it's reliable for authenticated users. For admin token requests, these fields may be null.

4. **Updates:** The `updatedBy` field is automatically updated whenever any bot field is modified via PUT.

5. **Room Relation:** The `room` object is always included in responses for convenience, but you can also fetch room details separately if needed.

## TypeScript Types

```typescript
interface BotUser {
  id: string;
  name: string | null;
  email: string | null;
}

interface Bot {
  id: string;
  roomId: string;
  name: string;
  description: string | null;
  characterTextureId: string | null;
  enabled: boolean;
  behaviorType: 'idle' | 'patrol' | 'social';
  behaviorConfig: Record<string, any>;
  chatInstructions: string | null;
  movementInstructions: string | null;
  aiProviderRef: string | null;
  createdAt: string;
  updatedAt: string;
  createdBy: BotUser | null;
  updatedBy: BotUser | null;
  room: {
    id: string;
    worldId: string;
    slug: string;
    name: string;
    description: string | null;
    mapUrl: string | null;
    wamUrl: string | null;
    isPublic: boolean;
    createdAt: string;
    updatedAt: string;
  };
}
```

## Migration Notes

- Existing bots in the database will have `createdBy` and `updatedBy` as `null`
- New bots created after this update will have these fields populated
- The API always returns these fields (as `null` if not available)
- No breaking changes to existing request/response formats

