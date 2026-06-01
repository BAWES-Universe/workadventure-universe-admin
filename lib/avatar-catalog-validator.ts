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

/**
 * Resolve texture IDs to their URLs by looking up the catalog database.
 * Searches all active avatar sets whose scope includes the given world/universe.
 *
 * Falls back to static config/woka.json if no catalog sets exist.
 */
export async function resolveTextureUrls(
  prisma: PrismaClient,
  textureIds: string[],
  worldId: string | null,
  universeId: string | null,
  playServiceUrl: string
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

  // Query all active, in-scope avatar sets with their layers and companions
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
    },
  })

  // Build a lookup map of textureId -> { id, url }
  const textureMap = new Map<string, { id: string; url: string; name: string | null }>()

  for (const set of sets) {
    for (const layer of set.layers) {
      if (!textureMap.has(layer.textureId)) {
        textureMap.set(layer.textureId, {
          id: layer.textureId,
          url: layer.url,
          name: layer.name,
        })
      }
    }
    for (const companion of set.companions) {
      if (!textureMap.has(companion.textureId)) {
        textureMap.set(companion.textureId, {
          id: companion.textureId,
          url: companion.url,
          name: companion.name,
        })
      }
    }
  }

  // Also check direct UserAvatarGrant sets for this user's textures
  // (assigned_only / hidden sets still need their textures to resolve)
  // For now, grants only affect visibility, not texture existence,
  // so we don't need to query grants here.

  // Resolve each requested texture ID
  const resolvedTextures: WokaDetail[] = []
  for (const textureId of textureIds) {
    const match = textureMap.get(textureId)
    if (!match) {
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
 * Validate a companion texture ID against the catalog.
 * Falls back to static config/companions.json.
 */
export async function resolveCompanionTexture(
  prisma: PrismaClient,
  companionTextureId: string | null,
  worldId: string | null,
  universeId: string | null,
  playServiceUrl: string
): Promise<CompanionValidationResult> {
  if (!companionTextureId) {
    return { valid: false, texture: null }
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

  // Look for the companion texture in active, scoped sets
  const companion = await prisma.avatarCompanion.findFirst({
    where: {
      textureId: companionTextureId,
      isActive: true,
      avatarSet: {
        lifecycle: 'active',
        scopes: { some: { OR: scopeFilter } },
      },
    },
    select: { textureId: true, url: true },
  })

  if (companion) {
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