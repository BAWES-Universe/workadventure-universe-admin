/**
 * Avatar Catalog Texture Validation
 *
 * Resolves texture IDs to URLs and validates them against the avatar catalog DB.
 * Replaces the static config/woka.json texture validation with catalog-powered lookups.
 * Falls back to static JSON when no catalog sets exist (zero-downtime migration).
 */

import { PrismaClient } from '@prisma/client'
import { getWokaList, getCompanions } from '@/lib/wokas'
import type { WokaList, WokaDetail, CompanionDetail } from '@/types/workadventure'

export interface TextureValidationResult {
  valid: boolean
  textures: WokaDetail[]
}

export interface CompanionValidationResult {
  valid: boolean
  texture: CompanionDetail | null
}

export interface UserValidationContext {
  userId?: string | null
  membershipTags?: string[]
  userEmail?: string | null
}

/**
 * Evaluates whether a user context satisfies entitlement and availability for an avatar set.
 */
export function isUserEntitledToSet(
  set: {
    visibility?: string
    availableFrom?: Date | null
    availableUntil?: Date | null
    policies?: Array<{
      action: string
      subjectType: string
      subjectValue: string | null
      worldId?: string | null
      isActive?: boolean
    }>
    userGrants?: Array<{
      grantType: string
      isActive: boolean
      expiresAt?: Date | null
    }>
  },
  userContext?: UserValidationContext,
  worldId?: string | null,
  now: Date = new Date()
): boolean {
  // Check availability window
  if (set.availableFrom && set.availableFrom > now) return false
  if (set.availableUntil && set.availableUntil < now) return false

  const visibility = set.visibility || 'public'
  const userId = userContext?.userId
  const membershipTags = userContext?.membershipTags || []
  const userEmail = userContext?.userEmail

  const hasGrant = Boolean(
    set.userGrants &&
      set.userGrants.some(
        (g) =>
          g.isActive &&
          g.grantType === 'select' &&
          (!g.expiresAt || g.expiresAt > now)
      )
  )

  if (visibility === 'public') {
    return true
  }

  if (visibility === 'hidden' || visibility === 'assigned_only') {
    return hasGrant
  }

  if (visibility === 'restricted') {
    if (hasGrant) return true

    const policies = set.policies || []
    return policies.some((p) => {
      if (p.isActive === false) return false
      if (p.action !== 'select' && p.action !== 'manage') return false
      if (p.worldId && p.worldId !== worldId) return false
      if (p.subjectType === 'everyone') return true
      if (p.subjectType === 'membership_tag') {
        return Boolean(p.subjectValue && membershipTags.includes(p.subjectValue))
      }
      if (p.subjectType === 'user') {
        return Boolean(userId && p.subjectValue === userId)
      }
      if (p.subjectType === 'email_domain') {
        if (!p.subjectValue || !userEmail) return false
        const domain = userEmail.split('@')[1]
        return domain === p.subjectValue
      }
      return false
    })
  }

  return false
}

/**
 * Resolve texture IDs to their URLs by looking up the catalog database.
 * Searches all active avatar sets whose scope includes the given world/universe,
 * enforcing availability windows, visibility policies, and per-user entitlement.
 *
 * Falls back to static config/woka.json if no catalog sets exist.
 */
export async function resolveTextureUrls(
  prisma: PrismaClient,
  textureIds: string[],
  worldId: string | null,
  universeId: string | null,
  playServiceUrl: string,
  userContext?: UserValidationContext
): Promise<TextureValidationResult> {
  if (!textureIds || textureIds.length === 0) {
    return { valid: false, textures: [] }
  }

  // Check if the catalog has any active sets first
  const catalogSetCount = await prisma.avatarSet.count({
    where: { lifecycle: 'active' },
  })

  // Fallback to static JSON if no catalog sets exist
  if (catalogSetCount === 0) {
    const wokaList = getWokaList(playServiceUrl)
    return validateTexturesFromStatic(textureIds, wokaList)
  }

  // Build scope filter
  const scopeFilter: Record<string, unknown>[] = [{ scopeType: 'platform' }]
  if (universeId) {
    scopeFilter.push({ scopeType: 'universe', scopeId: universeId })
  }
  if (worldId) {
    scopeFilter.push({ scopeType: 'world', scopeId: worldId })
  }

  const now = new Date()

  // Query all active, in-scope avatar sets with their layers, companions, policies, and user grants
  const sets = await prisma.avatarSet.findMany({
    where: {
      lifecycle: 'active',
      scopes: { some: { OR: scopeFilter } },
    },
    include: {
      layers: {
        where: { isActive: true },
        select: { textureId: true, name: true, url: true, layer: true },
      },
      companions: {
        where: { isActive: true },
        select: { textureId: true, name: true, url: true },
      },
      policies: {
        where: { isActive: true },
      },
      userGrants: {
        where: userContext?.userId
          ? { userId: userContext.userId, isActive: true }
          : { userId: '' },
      },
    },
  })

  // Build a lookup map of textureId -> { id, url, name } for ENTITLED sets only
  // Also track known catalog textures that the user is NOT entitled to
  const textureMap = new Map<string, { id: string; url: string; name: string | null }>()
  const unentitledTextureIds = new Set<string>()

  for (const set of sets) {
    const entitled = isUserEntitledToSet(set, userContext, worldId, now)

    for (const layer of set.layers) {
      if (entitled) {
        if (!textureMap.has(layer.textureId)) {
          textureMap.set(layer.textureId, {
            id: layer.textureId,
            url: layer.url,
            name: layer.name,
          })
        }
      } else {
        unentitledTextureIds.add(layer.textureId)
      }
    }
    for (const companion of set.companions) {
      if (entitled) {
        if (!textureMap.has(companion.textureId)) {
          textureMap.set(companion.textureId, {
            id: companion.textureId,
            url: companion.url,
            name: companion.name,
          })
        }
      } else {
        unentitledTextureIds.add(companion.textureId)
      }
    }
  }

  // Resolve each requested texture ID
  const resolvedTextures: WokaDetail[] = []
  for (const textureId of textureIds) {
    const match = textureMap.get(textureId)
    if (!match) {
      // If the texture belongs to an active catalog set the user is not entitled to, reject immediately
      if (unentitledTextureIds.has(textureId)) {
        return { valid: false, textures: [] }
      }

      // Texture not found in any active catalog set — check fallback
      const wokaList = getWokaList(playServiceUrl)
      const fallbackResult = validateTexturesFromStatic([textureId], wokaList)
      if (fallbackResult.valid && fallbackResult.textures.length > 0) {
        resolvedTextures.push(fallbackResult.textures[0])
      } else {
        return { valid: false, textures: [] }
      }
    } else {
      // Resolve URL — if relative, prepend play service URL
      const url = match.url.startsWith('http')
        ? match.url
        : `${playServiceUrl.replace(/\/$/, '')}/${match.url}`
      resolvedTextures.push({ id: match.id, name: match.name ?? undefined, url, layer: [] })
    }
  }

  return { valid: true, textures: resolvedTextures }
}

/**
 * Validate a companion texture ID against the catalog with entitlement check.
 * Falls back to static config/companions.json.
 */
export async function resolveCompanionTexture(
  prisma: PrismaClient,
  companionTextureId: string | null,
  worldId: string | null,
  universeId: string | null,
  playServiceUrl: string,
  userContext?: UserValidationContext
): Promise<CompanionValidationResult> {
  if (!companionTextureId) {
    return { valid: true, texture: null }
  }

  const catalogSetCount = await prisma.avatarSet.count({
    where: { lifecycle: 'active' },
  })

  if (catalogSetCount === 0) {
    // Static fallback
    const companions = getCompanions(playServiceUrl)
    const match = companions.find((c) => c.id === companionTextureId)
    return match ? { valid: true, texture: match } : { valid: false, texture: null }
  }

  // Build scope filter
  const scopeFilter: Record<string, unknown>[] = [{ scopeType: 'platform' }]
  if (universeId) {
    scopeFilter.push({ scopeType: 'universe', scopeId: universeId })
  }
  if (worldId) {
    scopeFilter.push({ scopeType: 'world', scopeId: worldId })
  }

  const now = new Date()

  // Look for the companion texture in active, scoped sets with policies and user grants
  const companion = await prisma.avatarCompanion.findFirst({
    where: {
      textureId: companionTextureId,
      isActive: true,
      avatarSet: {
        lifecycle: 'active',
        scopes: { some: { OR: scopeFilter } },
      },
    },
    include: {
      avatarSet: {
        include: {
          policies: { where: { isActive: true } },
          userGrants: {
            where: userContext?.userId
              ? { userId: userContext.userId, isActive: true }
              : { userId: '' },
          },
        },
      },
    },
  })

  if (companion) {
    const entitled = !companion.avatarSet || isUserEntitledToSet(companion.avatarSet, userContext, worldId, now)
    if (!entitled) {
      return { valid: false, texture: null }
    }

    const url = companion.url.startsWith('http')
      ? companion.url
      : `${playServiceUrl.replace(/\/$/, '')}/${companion.url}`
    return { valid: true, texture: { id: companion.textureId, url } }
  }

  // Fallback check in static JSON
  const companions = getCompanions(playServiceUrl)
  const fallbackMatch = companions.find((c) => c.id === companionTextureId)
  if (fallbackMatch) {
    return { valid: true, texture: fallbackMatch }
  }

  return { valid: false, texture: null }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Validates texture IDs against the static WokaList (from config/woka.json).
 * Used as fallback when no catalog sets exist.
 */
function validateTexturesFromStatic(
  textureIds: string[],
  wokaList: WokaList
): TextureValidationResult {
  const textureMap = new Map<string, WokaDetail>()

  for (const part of Object.values(wokaList)) {
    if (!part?.collections) continue
    for (const collection of part.collections) {
      for (const texture of collection.textures) {
        textureMap.set(texture.id, texture)
      }
    }
  }

  const resolved: WokaDetail[] = []
  for (const id of textureIds) {
    const match = textureMap.get(id)
    if (!match) return { valid: false, textures: [] }
    resolved.push(match)
  }

  return { valid: true, textures: resolved }
}