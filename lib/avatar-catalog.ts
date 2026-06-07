/**
 * Avatar Catalog — Core entitlement resolution engine.
 *
 * Evaluates which AvatarSets a player/bot/admin can access by checking:
 *   1. Scope     — is the set available in this world/universe/platform?
 *   2. Lifecycle — is the set active (not draft/archived)?
 *   3. Visibility— public / hidden / restricted / assigned_only
 *   4. Entitlement — matching EntitlementPolicy or direct UserAvatarGrant?
 */

import {
  PrismaClient,
  AvatarSet,
  AvatarLayer,
  AvatarCompanion,
  AvatarEntitlementPolicy,
  AvatarSetScope,
} from '@prisma/client'

export type AvatarSetFull = AvatarSet & {
  layers: AvatarLayer[]
  companions: AvatarCompanion[]
  scopes: AvatarSetScope[]
  policies: AvatarEntitlementPolicy[]
}

export interface ResolvePickerOptions {
  prisma: PrismaClient
  worldId: string | null
  universeId: string | null
  userId?: string | null
  membershipTags?: string[]
}

/**
 * Returns the sets a player is allowed to see and select in the woka picker.
 * hidden and assigned_only sets are always excluded from picker results.
 */
export async function resolvePickerSets(
  opts: ResolvePickerOptions
): Promise<AvatarSetFull[]> {
  const { prisma, worldId, universeId, userId, membershipTags = [] } = opts
  const now = new Date()

  const candidates = await prisma.avatarSet.findMany({
    where: {
      lifecycle: 'active',
      visibility: { in: ['public', 'restricted'] },
      AND: [
        { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
        { OR: [{ availableUntil: null }, { availableUntil: { gte: now } }] },
      ],
      scopes: {
        some: {
          OR: [
            { scopeType: 'platform' },
            ...(universeId
              ? [{ scopeType: 'universe', scopeId: universeId }]
              : []),
            ...(worldId
              ? [{ scopeType: 'world', scopeId: worldId }]
              : []),
          ],
        },
      },
    },
    include: {
      layers: { where: { isActive: true }, orderBy: { position: 'asc' } },
      companions: { where: { isActive: true }, orderBy: { position: 'asc' } },
      scopes: true,
      policies: { where: { isActive: true } },
    },
    orderBy: { position: 'asc' },
  })

  const eligible: AvatarSetFull[] = []

  for (const set of candidates) {
    if (set.visibility === 'public') {
      eligible.push(set)
      continue
    }
    if (set.visibility === 'restricted') {
      const hasAccess = checkPolicyMatch(set.policies, {
        userId: userId ?? null,
        membershipTags,
        worldId,
        action: 'select',
      })
      if (hasAccess) eligible.push(set)
    }
  }

  // Direct grants — includes assigned_only sets granted individually
  if (userId) {
    const grants = await prisma.userAvatarGrant.findMany({
      where: {
        userId,
        isActive: true,
        grantType: 'select',
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] },
        ],
      },
      include: {
        avatarSet: {
          include: {
            layers: { where: { isActive: true }, orderBy: { position: 'asc' } },
            companions: { where: { isActive: true }, orderBy: { position: 'asc' } },
            scopes: true,
            policies: { where: { isActive: true } },
          },
        },
      },
    })
    for (const grant of grants) {
      // Only include sets with active lifecycle
      if (grant.avatarSet.lifecycle === 'active' && !eligible.find((s) => s.id === grant.avatarSet.id)) {
        eligible.push(grant.avatarSet)
      }
    }
  }

  return eligible
}

/**
 * Returns ALL sets including draft/archived — for admin UI.
 */
export async function resolveAdminSets(
  prisma: PrismaClient
): Promise<AvatarSetFull[]> {
  return prisma.avatarSet.findMany({
    include: {
      layers: { orderBy: { position: 'asc' } },
      companions: { orderBy: { position: 'asc' } },
      scopes: true,
      policies: true,
    },
    orderBy: [{ lifecycle: 'asc' }, { position: 'asc' }],
  })
}

export interface ResolveBotOptions {
  prisma: PrismaClient
  userId: string
  isSuperAdmin: boolean
  worldId: string | null
  universeId: string | null
  membershipTags: string[]
}

/**
 * Returns avatar sets available for bot texture assignment.
 *
 * Super admins: see EVERY active set regardless of scope, visibility, or policy.
 *
 * Regular users: see only sets that are BOTH in-scope for the bot's world
 * AND accessible via one of:
 *   - visibility === 'public'
 *   - AvatarEntitlementPolicy(action: 'assign_to_bot') matching the user
 *   - UserAvatarGrant (direct grant)
 */
export async function resolveBotAssignableSets(
  opts: ResolveBotOptions
): Promise<AvatarSetFull[]> {
  const { prisma, userId, isSuperAdmin, worldId, universeId, membershipTags = [] } = opts
  const now = new Date()

  // Build the candidate query
  const where: any = {
    lifecycle: 'active',
    AND: [
      { OR: [{ availableFrom: null }, { availableFrom: { lte: now } }] },
      { OR: [{ availableUntil: null }, { availableUntil: { gte: now } }] },
    ],
  }

  // Non-super-admins: scope-filter candidates to the bot's universe/world + platform
  if (!isSuperAdmin) {
    where.scopes = {
      some: {
        OR: [
          { scopeType: 'platform' },
          ...(universeId ? [{ scopeType: 'universe', scopeId: universeId }] : []),
          ...(worldId ? [{ scopeType: 'world', scopeId: worldId }] : []),
        ],
      },
    }
  }

  const candidates = await prisma.avatarSet.findMany({
    where,
    include: {
      layers: { where: { isActive: true }, orderBy: { position: 'asc' } },
      companions: { where: { isActive: true }, orderBy: { position: 'asc' } },
      scopes: true,
      policies: { where: { isActive: true } },
    },
    orderBy: { position: 'asc' },
  })

  // Super admins: all active candidates are fair game
  if (isSuperAdmin) {
    return candidates
  }

  // Regular users: filter by visibility/policy/grant
  const accessible: AvatarSetFull[] = []

  for (const set of candidates) {
    if (set.visibility === 'public') {
      accessible.push(set)
      continue
    }

    // Hidden / restricted / assigned_only — check for assign_to_bot policy
    const hasPolicy = checkPolicyMatch(set.policies, {
      userId,
      membershipTags,
      worldId,
      action: 'assign_to_bot',
    })
    if (hasPolicy) {
      accessible.push(set)
      continue
    }
  }

  // Check direct UserAvatarGrants (overrides everything for the granted user)
  if (userId) {
    const grants = await prisma.userAvatarGrant.findMany({
      where: {
        userId,
        isActive: true,
        OR: [
          { grantType: 'select' },
          { grantType: 'assigned_only' },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gte: now } }] }],
      },
      include: {
        avatarSet: {
          include: {
            layers: { where: { isActive: true }, orderBy: { position: 'asc' } },
            companions: { where: { isActive: true }, orderBy: { position: 'asc' } },
            scopes: true,
            policies: { where: { isActive: true } },
          },
        },
      },
    })
    for (const grant of grants) {
      if (grant.avatarSet.lifecycle !== 'active') continue
      if (accessible.find((s) => s.id === grant.avatarSet.id)) continue

      // Grants still respect scope — a grant doesn't override world boundaries
      const inScope = grant.avatarSet.scopes.some(
        (s) =>
          s.scopeType === 'platform' ||
          (s.scopeType === 'universe' && s.scopeId === universeId) ||
          (s.scopeType === 'world' && s.scopeId === worldId)
      )
      if (!inScope) continue

      accessible.push(grant.avatarSet)
    }
  }

  return accessible
}

// ---------------------------------------------------------------------------
// WA Payload Builder
// ---------------------------------------------------------------------------

/**
 * A single texture entry matching the WA protobuf / Zod schema.
 * position is included for sort but stripped by Zod — that's fine.
 */
type WaTexture = { id: string; name: string; url: string; position: number }

/**
 * A named collection of textures for one customisation layer.
 * This maps to WokaTextureCollection in PlayerTextures.ts.
 */
type WaCollection = { name: string; textures: WaTexture[] }

/**
 * Part entry wrapping collections, matching the WA wokaPartType Zod schema.
 *   { body: { collections: [...], required?: boolean } }
 */
type WaPart = { collections: WaCollection[]; required?: boolean }

/**
 * Final woka list payload matching the WA protobuf WokaList format.
 * Each layer key maps to a WaPart with a collections array.
 */
export type WaWokaListPayload = {
  woka: WaPart
  body: WaPart
  eyes: WaPart
  hair: WaPart
  clothes: WaPart
  hat: WaPart
  accessory: WaPart
}

const LAYER_KEYS = [
  'woka',
  'body',
  'eyes',
  'hair',
  'clothes',
  'hat',
  'accessory',
] as const

/**
 * Transforms resolved AvatarSets into the WorkAdventure woka list payload.
 *
 * Output format matches the Zod schema in PlayerTextures.ts:
 *   Record<string, { collections: Array<{ name: string, textures: Array<{id, name, url}> }> }>
 *
 * Companion data is returned outside this payload — WA handles companions separately
 * via /api/room/access.
 */
export function buildWokaListPayload(
  sets: AvatarSetFull[],
  playUrl?: string
): WaWokaListPayload {
  const playServiceUrl = playUrl?.replace(/\/$/, '');
  // Build buckets per layer: each bucket accumulates WaCollection entries
  const buckets: Record<string, WaCollection[]> = {}
  for (const k of LAYER_KEYS) buckets[k] = []

  for (const set of sets) {
    // Group layers by their layer type (body, eyes, hair, etc.)
    const byLayer: Record<string, AvatarLayer[]> = {}
    for (const layer of set.layers) {
      if (!byLayer[layer.layer]) byLayer[layer.layer] = []
      byLayer[layer.layer].push(layer)
    }

    // Push one collection per layer type for this set
    for (const lk of LAYER_KEYS) {
      const items = byLayer[lk]
      if (!items?.length) continue
      buckets[lk].push({
        name: set.name,
        textures: items
          .sort((a, b) => a.position - b.position)
          .map((i) => ({
            id: i.textureId,
            name: i.name ?? i.textureId,
            url: i.url.startsWith('http')
              ? i.url
              : playServiceUrl
                ? `${playServiceUrl}/${i.url}`
                : i.url,
            position: i.position,
          })),
      })
    }
  }

  // Wrap each layer's collections array in a WaPart object
  const result: Record<string, WaPart> = {}
  for (const k of LAYER_KEYS) {
    result[k] = { collections: buckets[k] }
  }

  return result as WaWokaListPayload
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function checkPolicyMatch(
  policies: AvatarEntitlementPolicy[],
  ctx: {
    userId: string | null
    membershipTags: string[]
    worldId: string | null
    action: string
  }
): boolean {
  return policies.some((p) => {
    if (!p.isActive) return false
    if (p.action !== ctx.action && p.action !== 'manage') return false
    switch (p.subjectType) {
      case 'everyone':
        return true
      case 'membership_tag':
        return !!p.subjectValue && ctx.membershipTags.includes(p.subjectValue)
      case 'user':
        return !!p.subjectValue && p.subjectValue === ctx.userId
      default:
        return false
    }
  })
}
