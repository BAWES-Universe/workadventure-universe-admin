# Admin API Endpoints

Complete reference for all Admin API endpoints required for WorkAdventure integration.

## Table of Contents

- [Core Endpoints (Required)](#core-endpoints-required)
- [User Management Endpoints](#user-management-endpoints)
- [Map & Room Endpoints](#map--room-endpoints)
- [Woka & Companion Endpoints](#woka--companion-endpoints)
- [Moderation Endpoints](#moderation-endpoints)
- [OAuth & Authentication Endpoints](#oauth--authentication-endpoints)
- [Room API Endpoints](#room-api-endpoints)
- [Bot Server AI Provider Endpoints](#bot-server-ai-provider-endpoints)
- [Optional Endpoints](#optional-endpoints)

## Authentication

All endpoints require Bearer token authentication in the `Authorization` header:

```
Authorization: {ADMIN_API_TOKEN}
```

If authentication fails, return `401 Unauthorized` or `403 Forbidden`.

---

## Core Endpoints (Required)

These endpoints are essential for basic WorkAdventure functionality.

### GET /api/capabilities

Returns the capabilities/features supported by your Admin API.

**Request:**
- Method: `GET`
- Headers: No authentication required (public endpoint)

**Note:** This endpoint is intentionally public. WorkAdventure calls it during startup without an Authorization header to discover API capabilities.

**Response:** `200 OK`
```json
{
  "api/woka/list": "v1",
  "api/save-name": "v1",
  "api/save-textures": "v1",
  "api/ice-servers": "v1"
}
```

**Notes:**
- This endpoint is called at WorkAdventure startup
- Return an object mapping endpoint paths to version strings
- If an endpoint is not listed, WorkAdventure will skip calling it
- Return `404` if you don't want to implement capabilities (WorkAdventure will use defaults)

---

### GET /api/map

Maps a Play URI to map details or redirects to another room.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`, `Accept-Language: {locale}`
- Query Parameters:
  - `playUri` (required): Full WorkAdventure URL
    - Example: `http://play.workadventure.localhost/@/universeSlug/worldSlug/roomSlug`
  - `userId` (optional): User identifier (UUID or email)
  - `accessToken` (optional): OIDC access token

**Response:** `200 OK`

**Success Response (MapDetailsData):**
```json
{
  "mapUrl": "https://example.com/maps/world.json",
  "wamSettings": {
    "wamUrl": "https://example.com/wam/world.wam"
  },
  "policy": "public",
  "tags": ["editor", "member"],
  "authenticationMandatory": false,
  "roomName": "My Office",
  "contactPage": "https://example.com/contact"
}
```

**Redirect Response (RoomRedirect):**
```json
{
  "redirectUrl": "http://play.workadventure.localhost/@/universeSlug/worldSlug/otherRoom"
}
```

**Error Response:**
```json
{
  "status": "error",
  "type": "error",
  "title": "Map not found",
  "subtitle": "The requested map does not exist",
  "code": "MAP_NOT_FOUND",
  "details": "The map for this room could not be found."
}
```

**HTTP Status Codes:**
- `200` - Success (returns MapDetailsData or RoomRedirect)
- `401` - Unauthorized (returns ErrorApiRedirectData)
- `403` - Forbidden (returns ErrorApiUnauthorizedData)
- `404` - Not found (returns ErrorApiErrorData)

---

### GET /api/room/access

Returns member information and access permissions for a room.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`, `Accept-Language: {locale}`
- Query Parameters:
  - `userIdentifier` (required): User UUID or email
  - `playUri` (required): Full WorkAdventure URL
  - `ipAddress` (required): User's IP address
  - `characterTextureIds` (optional): Array of texture IDs
  - `companionTextureId` (optional): Companion texture ID
  - `accessToken` (optional): OIDC access token
  - `isLogged` (deprecated): Use `accessToken` instead
  - `chatID` (optional): Matrix chat ID

**Response:** `200 OK`

**Success Response:**
```json
{
  "status": "ok",
  "email": "user@example.com",
  "username": "John Doe",
  "userUuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "tags": ["editor", "admin"],
  "visitCardUrl": "https://example.com/profile/john",
  "isCharacterTexturesValid": true,
  "characterTextures": [
    {
      "id": "male1",
      "url": "https://example.com/wokas/male1.png",
      "layer": []
    }
  ],
  "isCompanionTextureValid": true,
  "companionTexture": {
    "id": "dog1",
    "url": "https://example.com/companions/dog1.png"
  },
  "messages": [],
  "userRoomToken": "",
  "activatedInviteUser": true,
  "applications": [],
  "canEdit": true,
  "world": "worldSlug",
  "chatID": "@john:matrix.org"
}
```

**Error Response:**
```json
{
  "status": "error",
  "type": "error",
  "title": "Access denied",
  "subtitle": "You do not have access to this room",
  "image": "",
  "code": "ROOM_ACCESS_DENIED",
  "details": "You need to be a member to access this room."
}
```

**Notes:**
- This is one of the most important endpoints
- Called every time a user tries to access a room
- Use `ipAddress` to check for bans
- Return empty `characterTextures` array to redirect user to Woka selection
- Return `isCharacterTexturesValid: false` to force Woka selection

---

## User Management Endpoints

### GET /api/members

Search for members by name, email, etc.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`
- Query Parameters:
  - `playUri` (required): Room URL
  - `searchText` (required): Search query

**Response:** `200 OK`
```json
[
  {
    "uuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
    "name": "John Doe",
    "email": "john@example.com",
    "tags": ["editor"],
    "texture": "male1",
    "visitCardUrl": "https://example.com/profile/john"
  }
]
```

---

### GET /api/members/{memberUUID}

Get member details by UUID.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`
- Path Parameters:
  - `memberUUID` (required): Member UUID

**Response:** `200 OK`
```json
{
  "uuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "name": "John Doe",
  "email": "john@example.com",
  "tags": ["editor"],
  "texture": "male1",
  "visitCardUrl": "https://example.com/profile/john"
}
```

**Error:** `404 Not Found` if member doesn't exist

---

### PUT /api/members/{userIdentifier}/chatId

Update a user's Matrix chat ID.

**Request:**
- Method: `PUT`
- Headers: `Authorization: Bearer {token}`
- Path Parameters:
  - `userIdentifier` (required): User UUID or email
- Body:
```json
{
  "chatId": "@john:matrix.org",
  "userIdentifier": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "roomUrl": "http://play.workadventure.localhost/@/universeSlug/worldSlug/roomSlug"
}
```

**Response:** `200 OK`

---

## Map & Room Endpoints

### GET /api/room/sameWorld

Get all rooms in the same world.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`, `Accept-Language: {locale}`
- Query Parameters:
  - `roomUrl` (required): Room URL
  - `tags` (optional): Comma-separated list of tags to filter
  - `bypassTagFilter` (optional): Boolean to bypass tag filtering

**Response:** `200 OK`
```json
[
  {
    "name": "Office 1",
    "roomUrl": "http://play.workadventure.localhost/@/universeSlug/worldSlug/room1",
    "wamUrl": "http://play.workadventure.localhost/@/universeSlug/worldSlug/room1"
  },
  {
    "name": "Office 2",
    "roomUrl": "http://play.workadventure.localhost/@/universeSlug/worldSlug/room2",
    "wamUrl": "http://play.workadventure.localhost/@/universeSlug/worldSlug/room2"
  }
]
```

---

### GET /api/room/tags

Get all tags used in a room (for autocomplete).

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`
- Query Parameters:
  - `roomUrl` (required): Room URL

**Response:** `200 OK`
```json
["editor", "admin", "member", "guest"]
```

---

### GET /api/world/tags

Search tags in a world.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`
- Query Parameters:
  - `playUri` (required): Room URL
  - `searchText` (required): Search query

**Response:** `200 OK`
```json
["editor", "admin"]
```

---

## Woka & Companion Endpoints

### GET /api/woka/list

Get list of available Wokas (avatars) for a user.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`
- Query Parameters:
  - `roomUrl` (required): Room URL
  - `uuid` (required): User UUID or email

**Response:** `200 OK`
```json
{
  "collections": [
    {
      "name": "Default",
      "textures": [
        {
          "id": "male1",
          "url": "https://example.com/wokas/male1.png",
          "layer": []
        },
        {
          "id": "female1",
          "url": "https://example.com/wokas/female1.png",
          "layer": []
        }
      ]
    }
  ]
}
```

**Error:** `404 Not Found` if user or room not found

---

### GET /api/companion/list

Get list of available companions for a user.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`
- Query Parameters:
  - `roomUrl` (required): Room URL
  - `uuid` (required): User UUID or email

**Response:** `200 OK`
```json
[
  {
    "name": "Pets",
    "textures": [
      {
        "id": "dog1",
        "url": "https://example.com/companions/dog1.png"
      },
      {
        "id": "cat1",
        "url": "https://example.com/companions/cat1.png"
      }
    ]
  }
]
```

---

### POST /api/save-name

Save a user's display name.

**Request:**
- Method: `POST`
- Headers: `Authorization: Bearer {token}`
- Body:
```json
{
  "playUri": "http://play.workadventure.localhost/@/teamSlug/worldSlug/roomSlug",
  "userIdentifier": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "name": "John Doe"
}
```

**Response:** `204 No Content`

**Error:** `404 Not Found` if user or room not found

**Note:** This endpoint is optional. Advertise it in `/api/capabilities` as `"api/save-name": "v1"`

---

### POST /api/save-textures

Save a user's Woka textures.

**Request:**
- Method: `POST`
- Headers: `Authorization: Bearer {token}`
- Body:
```json
{
  "playUri": "http://play.workadventure.localhost/@/teamSlug/worldSlug/roomSlug",
  "userIdentifier": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "textures": ["male1", "hat1"]
}
```

**Response:** `204 No Content`

**Error:** `404 Not Found` if user or room not found

**Note:** This endpoint is optional. Advertise it in `/api/capabilities` as `"api/save-textures": "v1"`

---

### POST /api/save-companion-texture

Save a user's companion texture.

**Request:**
- Method: `POST`
- Headers: `Authorization: Bearer {token}`
- Body:
```json
{
  "playUri": "http://play.workadventure.localhost/@/teamSlug/worldSlug/roomSlug",
  "userIdentifier": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "texture": "dog1"
}
```

**Response:** `204 No Content`

**Error:** `404 Not Found` if user or room not found

**Note:** This endpoint is optional. Advertise it in `/api/capabilities` as `"api/save-textures": "v1"` (same capability as save-textures)

---

## Moderation Endpoints

### GET /api/ban

Check if a user is banned.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`, `Accept-Language: {locale}`
- Query Parameters:
  - `token` (required): User UUID or email
  - `ipAddress` (required): User's IP address
  - `roomUrl` (required): Room URL

**Response:** `200 OK`
```json
{
  "is_banned": false,
  "message": ""
}
```

**Banned Response:**
```json
{
  "is_banned": true,
  "message": "You have been banned from this world for violating our terms of service."
}
```

---

### POST /api/ban

Ban a user.

**Request:**
- Method: `POST`
- Headers: `Authorization: Bearer {token}`
- Body:
```json
{
  "uuidToBan": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "playUri": "http://play.workadventure.localhost/@/teamSlug/worldSlug/roomSlug",
  "name": "John Doe",
  "message": "Violation of terms",
  "byUserUuid": "admin-uuid-here"
}
```

**Response:** `200 OK` (boolean)

---

### POST /api/report

Report a user.

**Request:**
- Method: `POST`
- Headers: `Authorization: Bearer {token}`, `Accept-Language: {locale}`
- Body:
```json
{
  "reportedUserUuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "reportedUserComment": "Inappropriate behavior",
  "reporterUserUuid": "reporter-uuid-here",
  "reportWorldSlug": "/@/universeSlug/worldSlug/roomSlug"
}
```

**Response:** `200 OK`

---

## OAuth & Authentication Endpoints

### GET /api/login-url/{organizationMemberToken}

Get member data from an organization token (for invite links).

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`, `Accept-Language: {locale}`
- Path Parameters:
  - `organizationMemberToken` (required): Organization member token
- Query Parameters:
  - `playUri` (required): Room URL

**Response:** `200 OK`
```json
{
  "userUuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "email": "user@example.com",
  "roomUrl": "/@/universeSlug/worldSlug/roomSlug",
  "mapUrlStart": "https://example.com/maps/world.json",
  "messages": []
}
```

**Error:** `401 Unauthorized` or `404 Not Found`

---

### GET /oauth/logout

Logout OAuth session.

**Request:**
- Method: `GET`
- Query Parameters:
  - `token` (required): OAuth token

**Response:** `200 OK`

---

### POST /api/oauth/refreshtoken

Refresh an OAuth token.

**Request:**
- Method: `POST`
- Headers: `Authorization: Bearer {token}`
- Body:
```json
{
  "accessToken": "expired-token-here"
}
```

**Response:** `200 OK`
```json
{
  "accessToken": "new-access-token",
  "refreshToken": "new-refresh-token",
  "expiresIn": 3600
}
```

---

## Room API Endpoints

### GET /api/room-api/authorization

Authorize access to Room API (gRPC API).

**Request:**
- Method: `GET`
- Headers: `X-API-Key: {apiKey}`
- Query Parameters:
  - `roomUrl` (required): Encoded room URL

**Response:** `200 OK`

**Success:**
```json
{
  "success": true
}
```

**Error:**
```json
{
  "success": false,
  "error": "UNAUTHENTICATED" | "NOT_FOUND" | "PERMISSION_DENIED" | "INTERNAL" | "UNKNOWN",
  "message": "Error message"
}
```

**HTTP Status Codes:**
- `200` - Success or error (check `success` field)
- `400` - Bad request
- `401` - Unauthenticated
- `403` - Permission denied
- `404` - Not found
- `500` - Internal server error

---

## Chat Endpoints

### GET /api/chat/members

Get list of members for chat display (member directory/search feature).

**Note:** This endpoint is NOT for chat messages. Matrix handles all actual chat messaging. This endpoint provides a searchable member directory for the chat UI, allowing users to:
- Search for members to mention or chat with
- See who's available in the world
- Map WorkAdventure users to their Matrix chat IDs

**How it works:**
1. Parse the `playUri` to extract `universeSlug` and `worldSlug`
2. Query your database (using Prisma) for all `WorldMember` records where:
   - The world matches the `worldSlug` and `universeSlug`
   - Optionally filter by `searchText` (name/email search)
3. Return the list with Matrix chat IDs

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`
- Query Parameters:
  - `playUri` (required): Room URL (format: `http://play.workadventure.localhost/@/universeSlug/worldSlug/roomSlug`)
  - `searchText` (optional): Search filter for member names/emails

**Response:** `200 OK`
```json
{
  "total": 10,
  "members": [
    {
      "uuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
      "wokaName": "John Doe",
      "email": "user@example.com",
      "chatId": "@john:matrix.org",
      "tags": ["member"]
    }
  ]
}
```

**Implementation Notes:**
- Use Prisma to query `WorldMember` table joined with `User` table
- Filter by world using the `universeSlug` and `worldSlug` from the parsed `playUri`
- The `chatId` field should contain the Matrix user ID (stored in `User.matrixChatId`)
- Only return members who have a `chatId` (Matrix ID) set
- See [DATABASE.md](./DATABASE.md) for the Prisma schema and implementation examples

---

## Bot Server AI Provider Endpoints

These endpoints are for bot servers to fetch AI provider credentials and track usage. They use a separate service token (`BOT_SERVICE_TOKEN`) instead of the standard `ADMIN_API_TOKEN`.

**Authentication:** All endpoints require `Authorization: Bearer {BOT_SERVICE_TOKEN}` header.

**Note:** See [docs/bots/AI_PROVIDERS.md](./bots/AI_PROVIDERS.md) for complete integration guide.

### GET /api/bots/ai-providers

List available AI providers (metadata only, no credentials).

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {BOT_SERVICE_TOKEN}`
- Query Parameters:
  - `enabled` (optional, boolean): Filter by enabled status
  - `type` (optional, string): Filter by provider type

**Response:** `200 OK`
```json
[
  {
    "providerId": "lmstudio-local",
    "name": "LMStudio Local",
    "type": "lmstudio",
    "enabled": true,
    "supportsStreaming": true
  }
]
```

**Error:** `401 Unauthorized` if service token is invalid

---

### GET /api/bots/ai-providers/:providerId/credentials

Get full provider configuration including encrypted credentials.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {BOT_SERVICE_TOKEN}`
- Path Parameters:
  - `providerId` (required): Provider ID

**Response:** `200 OK`
```json
{
  "providerId": "lmstudio-local",
  "name": "LMStudio Local",
  "type": "lmstudio",
  "enabled": true,
  "endpoint": "http://localhost:1234",
  "apiKeyEncrypted": "iv:authTag:encryptedData",
  "model": "local-model",
  "temperature": 0.7,
  "maxTokens": 500,
  "supportsStreaming": true,
  "settings": {}
}
```

**Important:** 
- `apiKeyEncrypted` is encrypted (format: `iv:authTag:encryptedData` - all hex strings)
- Bot server must decrypt using `ENCRYPTION_KEY` environment variable
- Returns `null` for `apiKeyEncrypted` if provider doesn't need an API key

**Error Codes:**
- `401 Unauthorized` - Invalid service token
- `404 Not Found` - Provider not found
- `400 Bad Request` - Provider is not enabled

---

### POST /api/bots/ai-usage

Track AI usage (tokens, API calls, costs). This is fire-and-forget - always returns success.

**Request:**
- Method: `POST`
- Headers: `Authorization: Bearer {BOT_SERVICE_TOKEN}`, `Content-Type: application/json`
- Body:
```json
{
  "botId": "bot-123",
  "providerId": "lmstudio-local",
  "tokensUsed": 150,
  "apiCalls": 1,
  "latency": 1250,
  "durationSeconds": null,
  "cost": 0.0015,
  "error": false,
  "timestamp": "2025-01-09T12:00:00Z"
}
```

**Response:** `200 OK`
```json
{
  "status": "tracked"
}
```

**Note:** Always returns `200 OK` even if tracking fails (fire-and-forget design)

**Request Body Fields:**
- `botId` (required, string): Bot identifier
- `providerId` (required, string): Provider ID
- `tokensUsed` (optional, number, default: 0): Tokens used (0 for voice AI)
- `apiCalls` (optional, number, default: 1): Number of API calls
- `durationSeconds` (optional, number, nullable): Duration in seconds (voice AI only, null for text AI)
- `cost` (optional, number, nullable): Calculated cost in USD/credits
- `latency` (optional, number, nullable): Request latency in milliseconds
- `error` (optional, boolean, default: false): Whether request resulted in error
- `timestamp` (optional, ISO 8601 string, default: now): When usage occurred

---

## Optional Endpoints

### GET /api/ice-servers

Get ICE servers for WebRTC connections.

**Request:**
- Method: `GET`
- Headers: `Authorization: Bearer {token}`
- Query Parameters:
  - `roomUrl` (required): Room URL
  - `userIdentifier` (required): User UUID or email

**Response:** `200 OK`
```json
[
  {
    "urls": "stun:stun.example.com:3478",
    "username": "",
    "credential": ""
  },
  {
    "urls": "turn:turn.example.com:3478",
    "username": "user",
    "credential": "pass"
  }
]
```

**Note:** This endpoint is optional. Advertise it in `/api/capabilities` as `"api/ice-servers": "v1"`. If not implemented, WorkAdventure will use environment variables.

---

### GET /white-label/cf-challenge

Cloudflare challenge verification (for white-labeling).

**Request:**
- Method: `GET`
- Query Parameters:
  - `host` (required): Hostname

**Response:** `200 OK`
```
challenge-string-here
```

---

## Error Response Format

All error responses should follow this format:

```json
{
  "status": "error",
  "type": "error" | "redirect" | "retry" | "unauthorized",
  "title": "Error Title",
  "subtitle": "Error Subtitle",
  "code": "ERROR_CODE",
  "details": "Detailed error message",
  "image": "https://example.com/error-image.png" // optional
}
```

**Error Types:**
- `error` - General error
- `redirect` - Redirect to another URL
- `retry` - Request should be retried
- `unauthorized` - Authentication/authorization error

## Best Practices

1. **Always validate input**: Check all required parameters
2. **Return proper HTTP status codes**: Use appropriate status codes
3. **Handle errors gracefully**: Return proper error responses
4. **Support Accept-Language header**: Return localized messages when possible
5. **Log important events**: Log access attempts, bans, reports, etc.
6. **Validate Bearer token**: Always verify the `ADMIN_API_TOKEN`
7. **Parse Play URIs correctly**: Extract universe, world, and room from Play URIs
8. **Cache when appropriate**: Cache map data, user data, etc. to improve performance

