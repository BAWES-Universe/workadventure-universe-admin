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

6. **POST /api/bots/:id/access** - Can this person do this with this bot? (#426)
   - Requires: `BOT_SERVICE_TOKEN` (the bot server and the game call it)
   - Body: `{ "action": "chat" | "dm" | "summon", "person": { "signedIn": boolean, "identifier"?: string } }`.
     `identifier` (their WorkAdventure identifier, an email when signed in) is required when `signedIn` is true and is
     never read for a guest, so a guest cannot borrow someone else's roles.
   - Returns: `{ "allowed": boolean, "code": "allowed" | "sign_in_required" | "not_allowed" | "no_room_access", "reason": string | null }`.
     `reason` is a line the game can show as it is. A no is a 200. Anything that stops Orbit answering is an error
     status (401 bad token, 400 bad body, 404 no such bot, 500), so the caller can tell "no" from "could not check".
   - Decided by the permissions Chat with bots nearby, DM bots and Summon bots (Roles & permissions, Bots group),
     read in the bot's world. Everyone has all three, so by default every bot works as it always has, guests included.
     A private chat also needs sign-in and a room the person may see. The bot's creator, the owner of its universe,
     super admins and Admin always pass.
   - Then the bot's own rules (#427), in this order: the person's own row, the rows of their roles (a Yes from any role
     beats a No from another, as in Discord), Private bot (only a Yes lets someone in), then the role permissions.
     A refused chat nearby also carries `reply`, the owner's own line for refused people, when the owner wrote one;
     the bot says it instead of calling the AI. A bot with no rows and Private bot off answers as above.

7. **GET /api/bots/:id/permissions** and **PUT /api/bots/:id/permissions** - Who may use this bot (#427)
   - Requires: whoever manages the bot (the universe owner, Admin, anyone with Manage bots in its room, or anyone the
     bot's own Manage rule says Yes to; a No takes it away). The bot's creator gets no extra way in here: once they no
     longer hold Manage bots they cannot change who may use the bot or its tools (#433). GET also takes the bot server's `ADMIN_API_TOKEN`.
     Anyone else gets 404, as if the bot did not exist.
   - GET returns `{ privateBot, refusalReply, dailyReplyCap, rules, roles }`: `rules` has one row per role or person with
     `chat`, `dm`, `summon` and `manage` each `"yes" | "no" | "default"`; `roles` lists the roles a row can name (not
     Admin, which always passes) with what each gives on its own (`defaults`), which is what Default means for it.
   - PUT takes any of `{ privateBot: boolean, refusalReply: string | null (up to 500 characters), dailyReplyCap: 1..10000 | null }`
     and returns the same as GET. `dailyReplyCap` is how many replies each person may get from this bot in a day;
     **null is no limit, and every bot starts with no limit**. It is only stored here: nothing limits replies today.
   - A Yes on Manage this bot (a person's row or a role's) only counts while the person is still in the universe, because
     rows stay when someone leaves. Everyone cannot be given Manage this bot (400); give it to a role or a person.

8. **PUT /api/bots/:id/permissions/rules** and **DELETE /api/bots/:id/permissions/rules?roleId=|userId=**
   - PUT body: one of `{ roleId }`, `{ userId }` or `{ identifier }` (a person's uuid or email), and any of `chat`, `dm`,
     `summon`, `manage` as `"yes" | "no" | "default"`. Only the actions sent change. Returns the row. Refused with a line
     saying why: a role of another universe (404), Admin, the universe owner or a super admin (400, they always pass),
     chat, dm or summon for the bot's creator (400, they always use their own bot; only `manage` can be set for them), a
     person who does not exist or may not be named here (404, the same answer for both: only people of this universe, its owner, the bot's creator and people findable by name can be named, so a rule can never be used to find out whether some email has an account), more than 200 rows (400), two people saving the same row at once (409, try again).
   - DELETE takes the row off, so they follow the roles again; 404 when there was no such row.

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

