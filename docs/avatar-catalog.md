# Avatar Catalog System

A scoped, permission-aware avatar and companion management platform for WorkAdventure Universe.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Data Model](#data-model)
4. [Scope Rules](#scope-rules)
5. [Visibility & Entitlement](#visibility--entitlement)
6. [Resolution Algorithm](#resolution-algorithm)
7. [API Reference](#api-reference)
8. [Admin Guide](#admin-guide)
9. [Bot Integration](#bot-integration)
10. [Migration Guide](#migration-guide)
11. [Business Model Hooks](#business-model-hooks)
12. [Operational Runbook](#operational-runbook)

---

## Overview

Before this system, wokas and companions were served from a static `config/woka.json`
file that returned the same flat list to every player regardless of who they were,
which world they were in, or whether they had any special access.

The Avatar Catalog replaces this with a **catalog + scope + entitlement** system:

| Concept | What it controls |
|---|---|
| **AvatarSet** | A named, publishable group of woka layers and/or companions |
| **AvatarSetScope** | *Where* a set is available: platform-wide, per-universe, or per-world |
| **AvatarEntitlementPolicy** | *Who* can use a restricted set: by membership tag, user ID, subscription plan, etc. |
| **UserAvatarGrant** | A direct per-user override: give one specific user access to any set |
| **AvatarSetAuditLog** | An immutable record of every change to the catalog |

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│               WorkAdventure Client               │
│          GET /api/woka/list?roomUrl=&uuid=        │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│           lib/avatar-catalog.ts                  │
│                                                  │
│  1. Resolve world + universe from roomUrl        │
│  2. Resolve user + membership tags               │
│  3. Query active sets in scope                   │
│  4. Filter by visibility + entitlement policies  │
│  5. Append direct UserAvatarGrant sets           │
│  6. Build WA-compatible woka list payload        │
│                                                  │
│  Fallback: config/woka.json (if 0 catalog sets)  │
└────────────────────┬────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────┐
│                  PostgreSQL                      │
│  avatar_sets, avatar_layers, avatar_companions   │
│  avatar_set_scopes, avatar_entitlement_policies  │
│  user_avatar_grants, avatar_set_audit_logs       │
└─────────────────────────────────────────────────┘
```

---

## Data Model

### AvatarSet

The primary entity. Represents a named, publishable group.

| Field | Type | Description |
|---|---|---|
| `slug` | string (unique) | URL-safe identifier, e.g. `zoo-animals`, `museum-staff` |
| `kind` | `woka` \| `companion` \| `mixed` | What asset types this set contains |
| `lifecycle` | `draft` \| `active` \| `archived` | Publication state |
| `visibility` | `public` \| `hidden` \| `restricted` \| `assigned_only` | Who sees it in picker |
| `sourceOwnerType` | `platform` \| `partner` \| `internal` \| `client` | Who created/owns this set |
| `monetizationType` | `free` \| `subscription` \| `purchase` \| `sponsored` \| `custom_contract` | Commercial model |
| `availableFrom` / `availableUntil` | datetime? | Availability window (null = no limit) |
| `partnerRef` | string? | External partner/client reference ID |
| `campaignCode` | string? | Campaign tracking code |
| `billingReference` | string? | Billing system reference |
| `licenseNotes` | string? | IP/license documentation |

### AvatarLayer

A single texture asset within a set, mapped to a WA customisation layer.

| Field | Description |
|---|---|
| `textureId` | The ID WA uses internally, e.g. `male1`, `hair23` |
| `layer` | One of: `woka`, `body`, `eyes`, `hair`, `clothes`, `hat`, `accessory` |
| `url` | Full or play-relative URL to the spritesheet |
| `position` | Display order within the layer picker |

### AvatarCompanion

A companion texture asset. Same shape as AvatarLayer but no `layer` field — companions are a separate picker category in WA.

### AvatarSetScope

Controls WHERE a set is available.

| `scopeType` | `scopeId` | Meaning |
|---|---|---|
| `platform` | null | Available everywhere |
| `universe` | Universe.id | Available only inside this universe |
| `world` | World.id | Available only inside this world |

A set can have **multiple scopes** — e.g. platform scope plus a specific world scope.

### AvatarEntitlementPolicy

Controls WHO can use a `restricted` or `assigned_only` set.

| `subjectType` | `subjectValue` | Effect |
|---|---|---|
| `everyone` | null | All authenticated users |
| `membership_tag` | tag string | Users with this tag in `WorldMember.tags` |
| `user` | User.id | One specific user |
| `email_domain` | `@company.com` | Users with matching email domain |
| `subscription_plan` | plan ID | Future: paid club memberships |
| `external_contract` | contract ref | Future: partner API grants |

`action` field values:
- `select` — can choose in woka picker
- `assign_to_bot` — admin can assign to bots
- `manage` — full admin rights on this set

### UserAvatarGrant

A direct per-user override. Bypasses all visibility rules.

- `grantType: "select"` — user can pick this in their picker
- `grantType: "assigned_only"` — admin has forced this outfit on the user
- Supports `expiresAt` for time-limited grants (event winners, trial access)
- Soft-revoke via `isActive = false` and `revokedAt` timestamp

### AvatarSetAuditLog

Immutable. Written on every catalog mutation. `diff` stores a `{ before, after }` JSON snapshot.

Action labels: `set.created`, `set.published`, `set.archived`, `set.updated`,
`layer.added`, `layer.removed`, `layer.updated`, `companion.added`, `companion.removed`,
`scope.added`, `scope.removed`, `policy.added`, `policy.removed`, `policy.updated`,
`grant.issued`, `grant.revoked`

---

## Scope Rules

Scope evaluation is **additive OR** — a set is in scope if any of its scopes match the current context:

```
IN SCOPE if:
  any scope WHERE scope_type = 'platform'
  OR any scope WHERE scope_type = 'universe' AND scope_id = currentUniverseId
  OR any scope WHERE scope_type = 'world'   AND scope_id = currentWorldId
```

A set with no scopes at all is **never** surfaced to players (it can only be seen in the admin).

---

## Visibility & Entitlement

### Visibility modes

| Mode | Player picker | Bot picker | Direct grant overrides |
|---|---|---|---|
| `public` | ✅ Visible to all | ✅ | N/A |
| `hidden` | ❌ Never | ✅ Admin assigns directly | N/A |
| `restricted` | ✅ Only to entitled users | ✅ | ✅ |
| `assigned_only` | ❌ Never | ❌ Except direct assignment | ✅ Only via UserAvatarGrant |

### Entitlement evaluation for `restricted` sets

```
CAN SELECT if:
  any active EntitlementPolicy WHERE action IN ('select','manage') AND (
    subjectType = 'everyone'
    OR (subjectType = 'membership_tag' AND subjectValue IN userTags)
    OR (subjectType = 'user' AND subjectValue = userId)
  )
  OR any active UserAvatarGrant WHERE userId = userId AND grantType = 'select' AND (expiresAt IS NULL OR expiresAt > now)
```

---

## Resolution Algorithm

Full pseudocode for `resolvePickerSets()`:

```
GIVEN: worldId, universeId, userId, membershipTags

1. SELECT active sets WHERE visibility IN ('public','restricted')
      AND within availability window
      AND has at least one in-scope AvatarSetScope

2. FOR EACH candidate set:
   IF visibility = 'public'  → include
   IF visibility = 'restricted' → checkPolicyMatch() → include if true

3. IF userId IS NOT NULL:
   SELECT active UserAvatarGrants WHERE userId AND grantType='select' AND not expired
   FOR EACH grant → include grant.avatarSet (dedup)

4. RETURN eligible sets

5. buildWokaListPayload(eligible) → WA-compatible JSON
```

---

## API Reference

### Player-Facing

| Method | Path | Description |
|---|---|---|
| GET | `/api/woka/list` | Returns picker payload for a player. Params: `roomUrl`, `uuid` |

### Admin — Sets

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/avatar-sets` | List all sets with counts |
| POST | `/api/admin/avatar-sets` | Create new set (starts as `draft`) |
| GET | `/api/admin/avatar-sets/:id` | Full set detail with all relations |
| PATCH | `/api/admin/avatar-sets/:id` | Update set metadata or lifecycle |
| DELETE | `/api/admin/avatar-sets/:id` | Soft-archive (blocks if active grants exist) |

### Admin — Layers & Companions

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/avatar-sets/:id/layers` | List layers |
| POST | `/api/admin/avatar-sets/:id/layers` | Add layer |
| PATCH | `/api/admin/avatar-sets/:id/layers/:layerId` | Update layer |
| DELETE | `/api/admin/avatar-sets/:id/layers/:layerId` | Remove layer |
| GET | `/api/admin/avatar-sets/:id/companions` | List companions |
| POST | `/api/admin/avatar-sets/:id/companions` | Add companion |
| PATCH | `/api/admin/avatar-sets/:id/companions/:companionId` | Update companion |
| DELETE | `/api/admin/avatar-sets/:id/companions/:companionId` | Remove companion |

### Admin — Scopes, Policies, Grants

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/avatar-sets/:id/scopes` | List scopes |
| POST | `/api/admin/avatar-sets/:id/scopes` | Add scope |
| DELETE | `/api/admin/avatar-sets/:id/scopes/:scopeId` | Remove scope |
| GET | `/api/admin/avatar-sets/:id/policies` | List policies |
| POST | `/api/admin/avatar-sets/:id/policies` | Add policy |
| PATCH | `/api/admin/avatar-sets/:id/policies/:policyId` | Toggle/update policy |
| DELETE | `/api/admin/avatar-sets/:id/policies/:policyId` | Remove policy |
| GET | `/api/admin/avatar-sets/:id/grants` | List user grants |
| POST | `/api/admin/avatar-sets/:id/grants` | Issue grant to user |
| DELETE | `/api/admin/avatar-sets/:id/grants/:grantId` | Revoke grant |

### Admin — Utilities

| Method | Path | Description |
|---|---|---|
| GET | `/api/admin/avatar-sets/:id/access-check` | Access tester: `?userId=&worldId=` |
| GET | `/api/admin/avatar-sets/bot-assignable` | All active sets for bot picker |

---

## Admin Guide

### Creating a new set

1. Go to **Admin → Avatar Catalog → New Set**
2. Fill in: name, slug, kind, visibility, source owner
3. Save → set is created in `draft` state (not visible to players)
4. Add layers and/or companions
5. Add at least one scope (platform, universe, or world)
6. If `restricted`, add at least one EntitlementPolicy
7. Click **Publish** → lifecycle changes to `active` → players can now see it

### Creating a bot-only (hidden) set for NPCs

1. Create set, visibility = `hidden`
2. Add the animal/NPC textures as layers
3. Add platform scope (or world scope if only for one world)
4. Publish
5. In **Admin → Bots**, each bot's character picker now shows this set
6. Players will never see it in their own picker

### Giving a user a custom character (e.g. Snoop Dogg)

1. Create set, visibility = `assigned_only`, kind = `woka`
2. Add the custom character textures
3. Publish with platform scope
4. Go to **Admin → Avatar Catalog → [Set] → Grants**
5. Issue a grant: userId = target user, grantType = `select`
6. Optionally set an expiry date
7. That user now sees the set in their picker; nobody else does

### Restricting a set to staff in a world

1. Create set, visibility = `restricted`
2. Add world scope for the target world
3. Add EntitlementPolicy: subjectType = `membership_tag`, subjectValue = `staff`, action = `select`
4. Publish
5. Any WorldMember with the `staff` tag in that world can now select the set
6. Grant the tag via **Admin → Memberships** as usual

### Access Tester

Navigate to **Admin → Avatar Catalog → [Set] → Access Check**.
Enter a User ID and World ID. The system returns a step-by-step check:
- Lifecycle ✓/✗
- Availability window ✓/✗
- Scope ✓/✗
- Visibility + Entitlement ✓/✗ (with reason)
- Final: `canSelect: true/false`

### Archiving a set

Click **Archive** on the set detail page.
- If active UserAvatarGrants exist, the system blocks archival and shows the count.
- Revoke all grants first, then archive.
- Archived sets are never deleted — they remain in the audit trail.

---

## Bot Integration

Bots use `Bot.characterTextureId` (existing field, no schema change needed).

The bot character picker in the admin UI calls `/api/admin/avatar-sets/bot-assignable`
which returns all active sets including `hidden` and `assigned_only` ones.

When building the bot spawn payload, the WorkAdventure bot service reads `characterTextureId`
directly — no picker resolution needed since bots don't interact with the player-facing picker.

To assign a bot-only animal set:
1. Create set with visibility = `hidden`
2. Add animal textures to the set
3. In the bot form, select any texture from this set as `characterTextureId`

---

## Migration Guide

### Step 1: Run the migration

```bash
npx prisma migrate deploy
# or in development:
npx prisma migrate dev --name avatar_catalog
```

### Step 2: Seed the Default set

```bash
npx ts-node prisma/seed-avatar-catalog.ts
```

This imports all textures from `config/woka.json` into a `Default` platform AvatarSet
with `lifecycle: active` and `visibility: public`. Existing players will see no change.

### Step 3: Verify fallback is working

If the seed hasn't run yet, `/api/woka/list` falls back to the static JSON automatically.
Once the Default set exists with active layers, the catalog takes over.

### Step 4: Progressive rollout

- Leave the Default set as the only active set initially
- Add new sets in `draft`, configure them fully, then publish when ready
- The static `config/woka.json` remains as an emergency fallback

---

## Business Model Hooks

All commercial metadata fields exist in the schema from day one. No future migrations needed to support these use cases:

| Use Case | How to implement |
|---|---|
| **Free default sets** | `monetizationType: free`, `visibility: public` |
| **Habbo Club / paid fashion** | `monetizationType: subscription`, `visibility: restricted` + policy `subjectType: subscription_plan` |
| **Event-limited drop** | `availableFrom` + `availableUntil` window |
| **Client universe-branded sets** | `sourceOwnerType: client`, `partnerRef: clientId`, universe scope |
| **Sponsored NPC mascots** | `sourceOwnerType: partner`, `visibility: hidden`, bot assignment |
| **Celebrity custom character** | `visibility: assigned_only` + `UserAvatarGrant` for the specific user |
| **Contest winner avatar** | `UserAvatarGrant` with `expiresAt` and `note: "Contest winner May 2026"` |
| **Global themed packs from partners** | Platform scope + `sourceOwnerType: partner` + `monetizationType: purchase` |

---

## Operational Runbook

### Why can't a user see a set I published?

Use the **Access Tester** (`/api/admin/avatar-sets/:id/access-check?userId=&worldId=`).
It returns step-by-step checks with human-readable reasons.

Common causes:
- Set has no scope → add platform or world scope
- Set is `restricted` but no matching policy → add EntitlementPolicy
- User lacks the required membership tag → add tag in Memberships panel
- Set is outside its availability window → check `availableFrom`/`availableUntil`

### A user is appearing with an unexpected avatar

Check `UserAvatarGrant` for the user. A direct grant overrides all visibility rules.
Also check `UserAvatar` in the database — this stores the last-chosen texture IDs.

### Archiving a set breaks a bot's appearance

Bots reference `characterTextureId` directly. When you archive a set:
1. Check which bots use textures from this set
2. Re-assign those bots to a texture from a different active set
3. Then archive

The archive endpoint blocks on active `UserAvatarGrants` but does NOT check bot assignments.
This is a known limitation — a future iteration should cross-check `Bot.characterTextureId` against the set's `textureId`s before allowing archival.

### Audit trail

Every change (create, publish, archive, add layer, remove layer, add scope, add policy,
issue grant, revoke grant) writes an `AvatarSetAuditLog` row with the actor, action label,
and a before/after JSON diff. Query via:

```sql
SELECT al.*, u.name AS actor_name
FROM avatar_set_audit_logs al
LEFT JOIN users u ON u.id = al.actor_id
WHERE al.avatar_set_id = '<set_id>'
ORDER BY al.created_at DESC
LIMIT 100;
```

### Known limitations in v1

- `email_domain`, `subscription_plan`, and `external_contract` policy types are modelled
  in the schema but the `checkPolicyMatch()` function returns `false` for them.
  Implement when the respective entitlement sources (payment provider, SSO) are integrated.
- Bot archival safety check is not yet implemented (see above).
- The admin UI pages (`app/admin/avatars/`) are API-complete. Frontend pages are
  scaffolded — wire up to the API routes in the implementation sprint.
- No caching layer yet. For high-traffic deployments, cache the resolved picker
  payload by `(userId, worldId, catalogVersion)` with Redis and invalidate on
  any catalog mutation.
