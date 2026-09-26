# Orbit workflow inventory

Every workflow, role, entity action and navigation entry Orbit has today, as the
baseline for the Quests & Orbit work (issue #200). Walked from
`app/admin/config/navigation.ts` and every `app/admin/**/page.tsx`, with the API
routes each page calls.

## How to read this

| Column | Meaning |
| --- | --- |
| **View** | Where the workflow belongs inside the game. **compact view**: fits Orbit's right-hand panel (the game opens Orbit with `position: "right"`), a glance or a single decision. **full-screen view**: dense editors, tables and multi-step forms that need Orbit expanded (`allowFullScreen`). **both**: works in either. |
| **Mobile path** | How to reach it on a phone. Orbit has one menu for every screen size, the **Orbit menu** (`app/admin/components/mobile-nav.tsx`), grouped as *Personalize*, *Discover* and *Admin*. "Menu → Discover → Worlds" means open the Orbit menu, then the Discover group, then Worlds. |
| **Authorisation test** | The test file that proves who may do it, or **none — needs one**. |
| **Status** | **preserve**, **repair** (unsafe today; fix, do not carry forward), or **fixed in 0A (#208)** (tightened by `fix/orbit-authorisation-hardening`, covered by `__tests__/api/authorisation-scope.test.ts` on that branch). |

## Roles

| Role | How Orbit decides | Where |
| --- | --- | --- |
| Signed out / outside Universe | No Orbit session. Opened outside the game iframe or with no handshake reply: shows "Orbit runs inside Universe" only | `app/admin/login/page.tsx` |
| Signed-in user | Opaque v2 session from the game handshake (`Authorization: Bearer orb_sess_v2_…`) | `lib/auth-session.ts` `getSessionUser` |
| Universe owner | `universe.ownerId === user.id` | entity routes under `app/api/admin/universes`, `worlds`, `rooms` |
| World admin / editor | `WorldMember.tags` has `admin` (manage members) or `editor` (edit rooms) | `canManageWorldMembers`, room/world `canEdit` checks |
| Bot manager | Can manage the bot's room | `lib/bot-permissions.ts` `canManageBots` |
| Super admin | Email in `SUPER_ADMINS` | `lib/super-admin.ts` `isSuperAdmin`, `requireSuperAdmin` |
| Game server / bot service | `ADMIN_API_TOKEN` or `BOT_SERVICE_TOKEN`, not an Orbit user | `lib/auth.ts` `requireAuth`, `lib/service-tokens.ts` |

## Session and account

| Workflow | View | Mobile path | Authorisation test | Status |
| --- | --- | --- | --- | --- |
| Sign in through the game handshake (`orbit-auth-*-v2`) | compact view | Opens automatically from the game's Orbit button | `__tests__/api/auth/login.test.ts`, `__tests__/api/auth/session.test.ts` | preserve |
| Same-tab account switch: stored session only kept for the handshake's user, caches cleared otherwise | compact view | Automatic | `__tests__/lib/account-switch.test.ts` | preserve (added in #200) |
| Direct visit outside Universe: one line + link, nothing fetched | compact view | n/a (outside the game) | `__tests__/admin/login-direct-visit.test.tsx` | preserve (added in #200) |
| Load the shell / bootstrap (`/api/admin/bootstrap`, `/api/auth/me`) | both | Automatic | `__tests__/admin/admin-shell.test.tsx` (request lifecycle only, not authorisation) | preserve; authorisation test **none — needs one** |
| Sign out (`app/admin/logout-button.tsx`, `/api/auth/logout`) | compact view | **Not reachable**: `LogoutButton` is not rendered anywhere | none — needs one | repair (mount it, or drop it) |
| Per-user preferences (`GET`/`PUT /api/me/preferences`) | compact view | n/a (API) | `__tests__/api/me/preferences.test.ts` | preserve (added in #200) |
| Theme toggle | both | Top bar → theme toggle | n/a (client only) | preserve |

## Navigation entries (`app/admin/config/navigation.ts`)

| Entry | Route | Shown to | View | Mobile path | Authorisation test | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Dashboard | `/admin` | everyone signed in | compact view | Menu → Dashboard | none — needs one | preserve |
| Room Templates | `/admin/templates` | everyone signed in (management tabs super admin) | full-screen view | Menu → Room Templates | none — needs one | preserve |
| My Universes | `/admin/universes` | everyone signed in | both | Menu → Personalize → My Universes | `__tests__/api/admin/universes.test.ts` (list: admin token, 401) | preserve |
| My Stars | `/admin/stars` | everyone signed in | compact view | Menu → Personalize → My Stars | none — needs one | preserve |
| My Memberships | `/admin/memberships` | `requiresAuth` | compact view | Menu → Personalize → My Memberships | none — needs one | preserve |
| My Visit Card | `/admin/profile` | `requiresAuth` | compact view | Menu → Personalize → My Visit Card | none — needs one | preserve |
| Discover Universes | `/admin/discover/universes` | everyone signed in | both | Menu → Discover → Universes | none — needs one | preserve |
| Discover Worlds | `/admin/discover/worlds` | everyone signed in | both | Menu → Discover → Worlds | none — needs one | preserve |
| Discover Rooms | `/admin/discover/rooms` | everyone signed in | both | Menu → Discover → Rooms | none — needs one | preserve |
| Users | `/admin/users` | everyone signed in | both | Menu → Discover → Users | `__tests__/api/authorisation-scope.test.ts` (#208) | fixed in 0A (#208) |
| Avatar Sets | `/admin/avatars` | super admin | full-screen view | Menu → Admin → Avatar Sets | none — needs one | preserve |
| Bots | `/admin/bots` | super admin | full-screen view | Menu → Admin → Bots | none — needs one | preserve |
| AI Providers | `/admin/ai-providers` | super admin | full-screen view | Menu → Admin → AI Providers | `__tests__/api/admin/ai-providers.test.ts` (validation only; always mocked as super admin) → **none — needs one** for the 403 | preserve |
| AI Usage | `/admin/ai-providers/usage` | super admin | full-screen view | Menu → Admin → AI Usage | none — needs one | preserve |
| Bot Database | `/admin/bots/database` | super admin | full-screen view | Menu → Admin → Bot Database | `__tests__/api/authorisation-scope.test.ts` (#208) | fixed in 0A (#208) |
| MCP Servers | `/admin/bots/mcp-servers` | super admin | full-screen view | Menu → Admin → MCP Servers | none — needs one (`/api/admin/mcp-servers`) | preserve |

The menu only hides entries; every API route enforces its own check.

## Dashboard (`/admin`)

| Action | API | Who | View | Mobile path | Authorisation test | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Current location card | `/api/admin/rooms/from-play-uri`, `/api/admin/rooms/previous`, `/api/admin/analytics/rooms/:id` | signed in | compact view | Menu → Dashboard | analytics: `authorisation-scope.test.ts` (#208); the room lookups: none — needs one | analytics fixed in 0A (#208); rest preserve |
| Recently visited | `/api/admin/rooms/recent` | signed in (own visits) | compact view | Menu → Dashboard | none — needs one | preserve |
| Pending invitations alert | `/api/memberships/invitations` | signed in (own) | compact view | Menu → Dashboard | none — needs one | preserve |
| Stats + quick create links | bootstrap | signed in | compact view | Menu → Dashboard | none — needs one | preserve |

## Universes, worlds, rooms

| Action | Page | API | Who | View | Mobile path | Authorisation test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| List my universes | `/admin/universes` | `GET /api/admin/universes?scope=my` | signed in | both | Menu → Personalize → My Universes | `__tests__/api/admin/universes.test.ts` | preserve |
| Create universe | `/admin/universes/new` | `POST /api/admin/universes` | signed in (owner = self) | full-screen view | My Universes → New | none — needs one | preserve |
| View universe | `/admin/universes/[id]` | `GET /api/admin/universes/:id` | any signed-in user | both | My Universes / Discover → card | none — needs one | **repair**: no `isPublic`/membership check, so any signed-in user reads a private universe and its owner's email |
| Edit / delete universe | `/admin/universes/[id]` | `PATCH`/`DELETE /api/admin/universes/:id` | owner | full-screen view | universe → Edit / Delete | none — needs one | preserve |
| Universe visitors (analytics) | `/admin/universes/[id]` | `/api/admin/analytics/universes/:id` | scoped | full-screen view | universe → Visitors | `authorisation-scope.test.ts` (#208) | fixed in 0A (#208) |
| Create world | `/admin/worlds/new` | `POST /api/admin/worlds` | universe owner | full-screen view | universe → New world | none — needs one | preserve |
| View world | `/admin/worlds/[id]` | `GET /api/admin/worlds/:id` | any signed-in user | both | universe → world | none — needs one | **repair**: no `isPublic`/membership check on private worlds |
| Edit / delete world | `/admin/worlds/[id]` | `PATCH`/`DELETE /api/admin/worlds/:id` | universe owner | full-screen view | world → Edit / Delete | none — needs one | preserve |
| World members: list, add, change role, remove | `/admin/worlds/[id]` (`member-list`, `invite-member-dialog`) | `/api/admin/worlds/:id/members[/:memberId]`, `/visitors` | owner / world admin | full-screen view | world → Members | none — needs one | preserve |
| World invitations: list, cancel | `/admin/worlds/[id]` | `/api/admin/worlds/:id/invitations[/cancel]` | owner / world admin | full-screen view | world → Members | none — needs one | preserve |
| World visitors (analytics) | `/admin/worlds/[id]` | `/api/admin/analytics/worlds/:id` | scoped | full-screen view | world → Visitors | `authorisation-scope.test.ts` (#208) | fixed in 0A (#208) |
| Create room (optionally from template map) | `/admin/rooms/new` | `POST /api/admin/rooms`, `/api/admin/templates/maps/:id`, `/api/templates/:slug` | owner / world editor | full-screen view | world → New room; or template map → Create room | none — needs one | preserve |
| View room | `/admin/rooms/[id]` | `GET /api/admin/rooms/:id` | any signed-in user | both | world → room; Discover → Rooms | none — needs one | **repair**: no `isPublic`/membership check on private rooms |
| Edit room / switch template / delete | `/admin/rooms/[id]` | `PATCH`/`DELETE /api/admin/rooms/:id` | owner / world editor | full-screen view | room → Edit / Delete | none — needs one | preserve |
| Star / unstar room | `/admin/rooms/[id]`, `/admin/stars` | `POST /api/admin/rooms/:id/favorite` | signed in (own stars) | compact view | room → star; My Stars | none — needs one | preserve (check it refuses private rooms the user cannot see) |
| Room visitors (analytics) | `/admin/rooms/[id]`, cards | `/api/admin/analytics/rooms/:id` | scoped | both | room → Visitors | `authorisation-scope.test.ts` (#208) | fixed in 0A (#208) |
| My stars | `/admin/stars` | `GET /api/admin/stars/rooms` | signed in (own) | compact view | Menu → Personalize → My Stars | none — needs one | preserve |
| Discover universes / worlds / rooms | `/admin/discover/*` | `GET /api/admin/{universes,worlds,rooms}?scope=discover` | signed in (public only) | both | Menu → Discover → … | none — needs one | preserve |

## Memberships, users, visit card

| Action | Page | API | Who | View | Mobile path | Authorisation test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| My memberships | `/admin/memberships` | `GET /api/memberships/my` | signed in (own) | compact view | Menu → Personalize → My Memberships | none — needs one | preserve |
| Accept / reject invitation | `/admin/memberships` | `POST /api/memberships/invitations/:id/{accept,reject}` | invited user only (403 otherwise) | compact view | My Memberships → Invitations | none — needs one | preserve |
| Leave world | `/admin/memberships` | `DELETE /api/memberships/my/world/:id` | signed in (own) | compact view | My Memberships → Leave | none — needs one | preserve |
| Users list | `/admin/users` | `GET /api/admin/users` | scoped | both | Menu → Discover → Users | `authorisation-scope.test.ts` (#208) | fixed in 0A (#208) |
| User detail + access history | `/admin/users/[id]` | `GET /api/admin/users/:id`, `/api/admin/analytics/users/:id` | scoped | both | Users → user | `authorisation-scope.test.ts` (#208) | fixed in 0A (#208) |
| User's starred rooms | `/admin/users/[id]` | `GET /api/admin/users/:id/starred-rooms` | any signed-in user | both | Users → user → Stars | none — needs one | **repair**: any signed-in user lists anyone's starred rooms, private rooms included (not part of #208) |
| Invite user to a world | `/admin/users/[id]` (`invite-to-world-dialog`) | `GET /api/admin/users/:id/worlds`, `POST /api/admin/users/:id/invite` | owner / world admin | compact view | Users → user → Invite | none — needs one | preserve |
| Edit my visit card | `/admin/profile` | `GET`/`PUT /api/admin/profile` | signed in (own) | compact view | Menu → Personalize → My Visit Card | none — needs one | preserve |
| Public visit card page | n/a (game link) | `GET /api/profile/:uuid` | public by design | n/a | n/a | none — needs one | preserve |

## Room templates

| Action | Page | API | Who | View | Mobile path | Authorisation test | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Browse categories, templates, maps | `/admin/templates`, `/admin/templates/categories/[id]`, `/admin/templates/templates/[id]`, `/admin/templates/maps/[id]` | `GET /api/templates*` (public), `GET /api/admin/templates/maps/:id/rooms` (public rooms) | everyone | both | Menu → Room Templates | none — needs one | preserve |
| Create a room from a map | `/admin/templates/maps/[id]` | `GET /api/admin/worlds/managed` → `/admin/rooms/new` | owner / world admin | full-screen view | template map → Create room | none — needs one | preserve |
| Manage categories (create, edit, delete) | `/admin/templates/categories/*` | `/api/admin/templates/categories[/:id]` | super admin | full-screen view | Room Templates → Categories tab | none — needs one | preserve |
| Manage templates (create, edit, delete) | `/admin/templates/templates/*` | `/api/admin/templates[/:id]` | super admin | full-screen view | Room Templates → Templates tab | none — needs one | preserve |
| Manage maps (create, edit, delete, upload image) | `/admin/templates/maps/*` | `/api/admin/templates/maps[/:id]`, `/upload-image` | super admin | full-screen view | Room Templates → Maps tab | none — needs one | preserve |

## Super-admin tools

| Action | Page | API | View | Mobile path | Authorisation test | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Avatar sets: list, create, edit, delete | `/admin/avatars`, `/admin/avatars/new`, `/admin/avatars/[id]` | `/api/admin/avatar-sets[/:id]` | full-screen view | Menu → Admin → Avatar Sets | none — needs one | preserve |
| Avatar layers / companions: add, edit, delete, upload texture, texture usage | `/admin/avatars/[id]/layers/[layerId]`, `/admin/avatars/[id]/companions/[companionId]` | `/api/admin/avatar-sets/:id/{layers,companions}`, `/upload-texture`, `/api/admin/texture-usage` | full-screen view | Avatar set → layer / companion | none — needs one | preserve; **repair** `/api/admin/texture-usage` (any signed-in user; aggregate counts only, should be super admin) |
| Avatar set grants, scopes, policies | `/admin/avatars/[id]` | `/api/admin/avatar-sets/:id/{grants,scopes,policies}` | full-screen view | Avatar set → Access | none — needs one | preserve |
| Avatar set access tester | (API only) | `GET /api/admin/avatar-sets/:id/access-check` | full-screen view | n/a | none — needs one | **repair**: any signed-in user can probe another user's world membership and tags |
| Bot-assignable avatar sets | bot texture picker | `GET /api/admin/avatar-sets/bot-assignable` | full-screen view | n/a | none — needs one | preserve (signed in, scope-filtered) |
| Bots list and bot detail | `/admin/bots`, `/admin/bots/[id]` | `/api/admin/bots[/:id]` (super admin), `/api/bots/:id/{conversations,metrics,emotions}` | full-screen view | Menu → Admin → Bots | per-bot reads: `authorisation-scope.test.ts` (#208); admin list: none — needs one | per-bot reads fixed in 0A (#208); rest preserve |
| Bot conversations / memory / metrics / test results (global) | `/admin/bots/{conversations,memory,metrics,test-results}` | `/api/admin/bots/*` | full-screen view | Bots → tab | none — needs one | preserve |
| Bot data cleanup (preview, delete, deleteAll) and database stats | `/admin/bots/database` | `/api/bots/*/cleanup[/preview]`, `/api/bots/database/stats`, `/api/bots/memory/:id` | full-screen view | Menu → Admin → Bot Database | `authorisation-scope.test.ts` (#208) | fixed in 0A (#208) |
| Bot configuration (create, update, delete) | in-game bot tools | `/api/bots`, `/api/bots/:id`, `/api/bots/configuration[/:id]` | n/a | n/a | `__tests__/api/bots/configuration.test.ts` | preserve |
| Bot MCP servers: list, add, edit, delete, test, OAuth connect | `/admin/bots/[id]/mcp-servers`, `/admin/bots/mcp-servers` | `/api/bots/:id/mcp-servers[/:serverId][/test,/oauth/start]`, `/api/admin/mcp-servers` | full-screen view | Bots → bot → MCP servers; Menu → Admin → MCP Servers | `__tests__/api/bots/mcp-servers.test.ts` | preserve |
| AI providers: list, create, edit, delete, test | `/admin/ai-providers/*` | `/api/admin/ai-providers[/:id][/test]` | full-screen view | Menu → Admin → AI Providers | none — needs one (existing test never exercises a non-super-admin) | preserve |
| AI usage report | `/admin/ai-providers/usage` | `/api/admin/ai-providers/usage` | full-screen view | Menu → Admin → AI Usage | none — needs one | preserve |

## Service-to-service routes (no Orbit UI)

Called by the game or the bot service with `ADMIN_API_TOKEN` / `BOT_SERVICE_TOKEN`, never by an Orbit user: `/api/bots/metrics` (POST), `/api/bots/ai-usage`, `/api/bots/test/results`, `/api/bots/:id/conversations/:conversationId` (PUT), `/api/bots/ai-providers/:providerId/credentials`, and the WorkAdventure admin API (`/api/map`, `/api/room/*`, `/api/members`, `/api/ban`, `/api/report`, …). They are outside Orbit's compact / full-screen views; keep them as they are.

## Repair list

| # | Capability | Why unsafe | Suggested fix |
| --- | --- | --- | --- |
| 1 | `GET /api/admin/universes/:id`, `/worlds/:id`, `/rooms/:id` | Any signed-in user reads private entities, including the owner's email | Return 404 unless public, owned, member, or super admin; drop the owner's email for non-managers |
| 2 | `GET /api/admin/users/:id/starred-rooms` | Any signed-in user lists anyone's stars, private rooms included | Own stars, or public rooms only, unless super admin |
| 3 | `GET /api/admin/avatar-sets/:id/access-check` | Any signed-in user probes another user's world membership and tags | `requireSuperAdmin` |
| 4 | `GET /api/admin/texture-usage` | Any signed-in user; low impact (aggregate counts) | `requireSuperAdmin` |
| 5 | Sign out | `LogoutButton` exists but is never rendered | Mount it in the user menu, or remove it |

Items fixed in 0A (#208), not repeated here: users list and detail, all analytics routes, bot data cleanup and database stats, per-bot read routes.
