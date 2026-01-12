# Bot Management API - Setup Confirmation

## ✅ Setup Complete

The Bot Management API has been successfully implemented and set up.

### Database Schema
- ✅ `bots` table created in PostgreSQL
- ✅ All fields present: id, room_id, name, description, character_texture_id, enabled, behavior_type, behavior_config, chat_instructions, movement_instructions, ai_provider_ref, created_at, updated_at
- ✅ Foreign key constraint to `rooms` table with CASCADE delete
- ✅ Index on `room_id` for performance
- ✅ Relation added to `Room` model in Prisma schema

### Authentication

Bot management endpoints support two authentication methods, with **session tokens taking priority**:

1. **Session Token (Preferred)**
   - Send session token via `_token` URL parameter
   - Example: `GET /api/bots?roomId={roomId}&_token={sessionToken}`
   - Session tokens have 7-day expiration (independent of JWT)
   - Work even after WorkAdventure JWT expires
   - Obtain session token via `POST /api/auth/session` endpoint

2. **JWT AccessToken (Fallback)**
   - Send OIDC accessToken via `Authorization: Bearer {token}` header
   - Example: `GET /api/bots?roomId={roomId}` with `Authorization: Bearer {accessToken}`
   - Falls back to this if no session token provided
   - Will fail when JWT expires (typically 1 hour)

**Why Session Tokens?**
- Bot management UI needs to work continuously even after JWT expires
- Session tokens provide 7-day authentication window
- Same authentication mechanism as Orbit/Admin interface
- Supports cross-origin iframe scenarios via URL parameter

**Getting a Session Token:**
```bash
# Exchange OIDC token for session token
curl -X POST \
  -H "Authorization: Bearer YOUR_OIDC_ACCESS_TOKEN" \
  http://localhost:3333/api/auth/session

# Response:
# {
#   "sessionToken": "base64-encoded-session-data",
#   "expiresAt": 1768261238170
# }
```

### API Endpoints Created

1. **GET /api/bots?roomId={roomId}** - List bots for a room
   - Visibility: Public if room/world/universe are all public, otherwise requires auth
   - Returns: Array of bot objects with room relation

2. **POST /api/bots** - Create a new bot
   - Requires: Authentication + permission check
   - Returns: Created bot object (201)

3. **GET /api/bots/:id** - Get single bot
   - Visibility: Same rules as list endpoint
   - Returns: Single bot object with room relation

4. **PUT /api/bots/:id** - Update a bot
   - Requires: Authentication + permission check
   - Returns: Updated bot object

5. **DELETE /api/bots/:id** - Delete a bot
   - Requires: Authentication + permission check
   - Returns: 204 No Content

### Files Created/Modified

**New Files:**
- `lib/bot-permissions.ts` - Permission checking service
- `app/api/bots/route.ts` - List and create endpoints
- `app/api/bots/[id]/route.ts` - Get, update, delete endpoints

**Modified Files:**
- `prisma/schema.prisma` - Added Bot model and Room relation

### Permission System

The `canManageBots()` function checks:
- User is universe owner (room.world.universe.ownerId === userId), OR
- User is WorldMember with 'admin' or 'editor' tags

### Validation

- ✅ Zod schemas for create/update
- ✅ `behaviorType` enum validation ('idle', 'patrol', 'social')
- ✅ Field length validation (name max 100 chars, etc.)
- ✅ UUID validation for roomId
- ✅ JSON validation for behaviorConfig

### Error Handling

All endpoints return appropriate HTTP status codes:
- 400: Invalid input data
- 401: Unauthorized (missing/invalid auth)
- 403: Forbidden (lacks permission)
- 404: Not found
- 500: Internal server error

### TypeScript Linter Notes

The linter may show errors about `prisma.bot` not existing. This is expected and will resolve when:
1. The TypeScript server restarts/reloads
2. The IDE picks up the newly generated Prisma client types

The code is correct - the Prisma client was generated successfully and the database schema is in place.

### Testing

To test the API endpoints:

1. **Get a room ID:**
   ```bash
   docker exec admin-api-postgres psql -U workadventure -d workadventure_admin -t -c "SELECT id FROM rooms LIMIT 1;"
   ```

2. **List bots (using session token - recommended):**
   ```bash
   curl "http://localhost:3333/api/bots?roomId=ROOM_ID&_token=YOUR_SESSION_TOKEN"
   ```

   **OR using JWT (fallback):**
   ```bash
   curl -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     "http://localhost:3333/api/bots?roomId=ROOM_ID"
   ```

3. **Create a bot (using session token - recommended):**
   ```bash
   curl -X POST \
     -H "Content-Type: application/json" \
     -d '{
       "roomId": "ROOM_ID",
       "name": "Test Bot",
       "behaviorType": "social",
       "behaviorConfig": {
         "assignedSpace": {
           "center": { "x": 320, "y": 480 },
           "radius": 150
         }
       }
     }' \
     "http://localhost:3333/api/bots?_token=YOUR_SESSION_TOKEN"
   ```

   **OR using JWT (fallback):**
   ```bash
   curl -X POST \
     -H "Authorization: Bearer YOUR_JWT_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{
       "roomId": "ROOM_ID",
       "name": "Test Bot",
       "behaviorType": "social",
       "behaviorConfig": {
         "assignedSpace": {
           "center": { "x": 320, "y": 480 },
           "radius": 150
         }
       }
     }' \
     "http://localhost:3333/api/bots"
   ```

### Next Steps

1. Restart your IDE/TypeScript server to clear linter errors
2. Test the endpoints using the examples above
3. The API is ready for use in the WorkAdventure map editor interface

