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
   - Body: `{ "action": "chat" | "dm" | "summon" | "change" | "deleteOrSend", "person": { "signedIn": boolean, "identifier"?: string } }`.
     `identifier` (their WorkAdventure identifier, an email when signed in) is required when `signedIn` is true and is
     never read for a guest, so a guest cannot borrow someone else's roles.
   - Returns: `{ "allowed": boolean, "code": "allowed" | "sign_in_required" | "not_allowed" | "no_room_access", "reason": string | null }`.
     `reason` is a line the game can show as it is. A no is a 200. Anything that stops Orbit answering is an error
     status (401 bad token, 400 bad body, 404 no such bot, 500), so the caller can tell "no" from "could not check".
   - `change` and `deleteOrSend` (#737) ask whether this person may have the bot change things, or delete things or send
     email and messages outside Universe, with its tools. They are decided by the permissions Have bots change things
     (bit 17) and Have bots delete or send (bit 18) in the same Bots group, read in the bot's world, then the person's
     and roles' rows as below. Defaults: Admin and Editor both, Member change only, Everyone and custom roles neither.
     Private bot does not apply to them (it decides who may use the bot at all), and the bot's creator, the owner of its
     universe, super admins and Admin always pass. A no for them carries `code: "not_allowed"` and `reason: null`: there is
     no line to show as it is, the bot words its own refusal.
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
     `chat`, `dm`, `summon`, `manage`, `change` and `deleteOrSend` each `"yes" | "no" | "default"`; `roles` lists the roles a row can name (not
     Admin, which always passes) with what each gives on its own (`defaults`), which is what Default means for it.
   - PUT takes any of `{ privateBot: boolean, refusalReply: string | null (up to 500 characters), dailyReplyCap: 1..10000 | null }`
     and returns the same as GET. `dailyReplyCap` is how many replies each person may get from this bot in a day;
     **null is no limit, and every bot starts with no limit**. It is only stored here: nothing limits replies today.
   - A Yes on Manage this bot (a person's row or a role's) only counts while the person is still in the universe, because
     rows stay when someone leaves. Everyone cannot be given Manage this bot (400); give it to a role or a person.

8. **PUT /api/bots/:id/permissions/rules** and **DELETE /api/bots/:id/permissions/rules?roleId=|userId=**
   - PUT body: one of `{ roleId }`, `{ userId }` or `{ identifier }` (a person's uuid or email), and any of `chat`, `dm`,
     `summon`, `manage`, `change`, `deleteOrSend` as `"yes" | "no" | "default"`. Only the actions sent change. Returns the row. Refused with a line
     saying why: a role of another universe (404), Admin or the universe owner (400, they always pass; a super admin
     is saved like anyone else, so a rule cannot show who is one),
     chat, dm, summon, change or deleteOrSend for the bot's creator (400, they always use their own bot; only `manage` can be set for them), a
     person who does not exist or may not be named here (404, the same answer for both: only people of this universe, its owner, the bot's creator and people findable by name can be named, so a rule can never be used to find out whether some email has an account), more than 200 rows (400), two people saving the same row at once (409, try again).
   - DELETE takes the row off, so they follow the roles again; 404 when there was no such row.

9. **Tool settings** (#738): what each tool of a bot's MCP server is, and what the bot does with it
   - **GET /api/bots/:id/mcp-servers/:serverId/tools** returns the server's tools (`name`, `title`, `description`,
     `fingerprint`, `suggestedHeading`, `suggestionSource`, `heading`, who confirmed or moved it), the setting under each
     heading (`settings`), `policyRevision` and `state`: `"notCheckedYet"` for a server that existed before tools were
     checked (it keeps working in text), `"notConfirmedYet"` while a tool waits, `"confirmed"` when every tool is.
     Takes Manage bots, or the bot server's `ADMIN_API_TOKEN`.
   - **PUT /api/bots/:id/mcp-servers/:serverId/tools** (`ADMIN_API_TOKEN` only; a person gets 403): the bot server saves
     the full tool list it just read. A new tool waits to be confirmed; a tool whose `fingerprint` changed goes back to
     not confirmed; one the server no longer offers is removed. A suggestion never lets a tool run.
   - **PATCH .../tools/:toolId** moves one tool to another heading (`looksUp`, `makesNew`, `changesThings`,
     `deletesOrSends`); **POST .../tools/confirm** confirms all tools, or `{ toolIds }`. A tool takes the heading
     someone chose or, if none, the suggested one; a tool with neither is not confirmed (400 naming it).
   - **PUT .../policy** sets what the bot does under each heading: any of `looksUp`, `makesNew`, `changesThings`,
     `deletesOrSends` as `"rightAway" | "asksFirst" | "off"`. `policyRevision` goes up when one changes. A new server
     starts with looksUp and makesNew on `rightAway`, the others on `asksFirst`.
   - **GET/PUT /api/bots/:id/tool-settings**: the bot's own limits `askBeforeMaking` (3, 5, 10 or null for no limit;
     default 5), `askWhichWay` (`rarely`, `beforeBiggerJobs`, `never`; default `rarely`) and `cardWaitMinutes` (5, 10,
     30; default 10). GET also takes `ADMIN_API_TOKEN`.
   - Moving, confirming and every setting need Manage bots (403 without it, 401 when not signed in, 404 for no such bot).

10. **Saved bot actions** (#739): a record for each action that waits for a tap
    - For the bot server and the game only: every route takes `BOT_SERVICE_TOKEN` (the same as the access check). The
      bot server authenticates the person (the signed-in account, or the guest's server session) and passes who it was as
      `requesterKey` / `actorKey`; Orbit stores and compares those, it does not look people up.
    - **POST /api/bots/:id/actions** saves a request: `{ proposalKey, requesterKey, conversationKey, connectionRef?,
      toolName, heading, toolFingerprint, policyRevision, arguments, rememberScope?: { fixed, varies }, reviewMinutes? }`.
      The arguments are stored once, encrypted, exactly as shown, and are what runs. The same `proposalKey` again returns
      the request already saved (200); the same key with other content is a 409. `rememberScope` is what "allow more" would
      remember and is refused for `deletesOrSends`. **GET .../actions/:actionId** reads it (a card past its time, or an
      approval nobody started, is closed first).
    - States: `waiting`, `approved`, `running`, `done`, `failed`, `couldntConfirm`, `closed` (with `closedReason`:
      `declined`, `superseded`, `expired`, `stale`, `cancelled`, `revoked`). Every change is one conditional update on the
      status and `revision` the caller saw, so one tap wins; each change goes in the decision log (no card text).
    - **POST .../:actionId/decision** is the tap: `{ actorKey, revision, decision: "approve" | "approveAndRemember" |
      "decline" }` and nothing else. Only the asker may decide (403 `not_requester`). 200 when this tap won; 409 with
      `outcome: "already_decided" | "expired"` and the action as it is now when another tap, a replacement or the clock got
      there first (a double tap, a second device). An approval must be claimed within 30 seconds (`startWithinSeconds`).
    - **POST .../:actionId/claim** gives one dispatcher the one go at running an approved action (`{ claimed: true,
      attemptId, idempotencyKey }`), or a 409 `{ claimed: false, reason }`: `stale` after the start window, or the state it
      is already in. **POST .../finish** says how the attempt ended: `succeeded` (done), `failed` (failed), `notSent` (back
      to approved while the window lasts) or `uncertain` (**couldn't confirm: never claimed again by itself**).
      **POST .../reconcile** records what was found at the destination for a couldn't-confirm action (`succeeded` or
      `failed`). **POST /api/bots/:id/actions/sweep** closes expired cards and stale approvals, and turns a run whose claim
      ran out (its dispatcher died) into couldn't confirm.
    - **POST /api/bots/:id/actions/supersede** closes the asker's waiting (or approved-not-started) actions in one
      conversation when they send a replacement instruction.
    - Remembered approvals: **POST /api/bots/:id/action-grants/find** (is this call covered: same asker, conversation,
      connection, reviewed tool, policy revision and heading, inside the idle and absolute time, arguments fit; never for
      deletes or sends), **/touch** (the asker's own message renews the idle time, never past the absolute end) and
      **/revoke** (ask again, signed out, connection or policy changed, lost permission, left).
    - Defaults, each passable per call: a card waits 10 minutes (a bot's "A card waits" setting, #738), start within 30
      seconds, a claim lasts 120 seconds, a remembered approval ends after 60 minutes idle or 480 minutes at most.


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

