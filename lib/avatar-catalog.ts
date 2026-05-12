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
  userUuid: string | null
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
      if (!eligible.find((s) => s.id === grant.avatarSet.id)) {
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

/**
 * Returns all active sets including hidden/assigned_only — for bot assignment.
 */
export async function resolveBotAssignableSets(
  prisma: PrismaClient
): Promise<AvatarSetFull[]> {
  return prisma.avatarSet.findMany({
    where: { lifecycle: 'active' },
    include: {
      layers: { where: { isActive: true }, orderBy: { position: 'asc' } },
      companions: { where: { isActive: true }, orderBy: { position: 'asc' } },
      scopes: true,
      policies: true,
    },
    orderBy: { position: 'asc' },
  })
}

// ---------------------------------------------------------------------------
// WA Payload Builder
// ---------------------------------------------------------------------------

type WaTexture = { id: string; name: string; url: string; position: number }
type WaCollection = { name: string; textures: WaTexture[] }

export type WaWokaListPayload = {
  woka: WaCollection[]
  body: WaCollection[]
  eyes: WaCollection[]
  hair: WaCollection[]
  clothes: WaCollection[]
  hat: WaCollection[]
  accessory: WaCollection[]
  companion: WaCollection[]
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
 */
export function buildWokaListPayload(
  sets: AvatarSetFull[]
): WaWokaListPayload {
  const buckets: Record<string, WaCollection[]> = {}
  for (const k of LAYER_KEYS) buckets[k] = []
  const companionBucket: WaCollection[] = []

  for (const set of sets) {
    const byLayer: Record<string, AvatarLayer[]> = {}
    for (const layer of set.layers) {
      if (!byLayer[layer.layer]) byLayer[layer.layer] = []
      byLayer[layer.layer].push(layer)
    }

    for (const lk of LAYER_KEYS) {
      const items = byLayer[lk]
      if (!items?.length) continue
      buckets[lk].push({
        name: set.name,
        textures: items.map((i) => ({
          id: i.textureId,
          name: i.name ?? i.textureId,
          url: i.url,
          position: i.position,
        })),
      })
    }

    if (set.companions.length > 0) {
      companionBucket.push({
        name: set.name,
        textures: set.companions.map((c) => ({
          id: c.textureId,
          name: c.name ?? c.textureId,
          url: c.url,
          position: c.position,
        })),
      })
    }
  }

  return { ...(buckets as Omit<WaWokaListPayload, 'companion'>), companion: companionBucket }
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
