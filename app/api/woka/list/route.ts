/**
 * GET /api/woka/list?roomUrl=...&uuid=...
 *
 * Returns the woka picker payload for a player.
 * Resolves scope + entitlement via the avatar catalog engine.
 * Falls back to static config/woka.json when no active catalog sets exist
 * (zero-downtime migration path).
 */

import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import {
  resolvePickerSets,
  buildWokaListPayload,
} from '@/lib/avatar-catalog'
import { getWokaData } from '@/lib/wokas'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const roomUrl = searchParams.get('roomUrl')
  const uuid = searchParams.get('uuid')

  if (!roomUrl) {
    return NextResponse.json(
      { error: 'roomUrl is required' },
      { status: 400 }
    )
  }

  let worldId: string | null = null
  let universeId: string | null = null
  let userId: string | null = null
  let membershipTags: string[] = []

  try {
    const parsed = parsePlayUri(roomUrl)
    if (parsed) {
      const world = await prisma.world.findFirst({
        where: {
          slug: parsed.worldSlug,
          universe: { slug: parsed.universeSlug },
        },
        select: { id: true, universeId: true },
      })

      if (world) {
        worldId = world.id
        universeId = world.universeId

        if (uuid) {
          const user = await prisma.user.findUnique({
            where: { uuid },
            select: { id: true },
          })
          if (user) {
            userId = user.id
            const member = await prisma.worldMember.findUnique({
              where: {
                userId_worldId: { userId: user.id, worldId: world.id },
              },
              select: { tags: true },
            })
            membershipTags = member?.tags ?? []
          }
        }
      }
    }
  } catch {
    // Non-fatal — fall through to platform-scope sets
  }

  const sets = await resolvePickerSets({
    prisma,
    worldId,
    universeId,
    userUuid: uuid,
    userId,
    membershipTags,
  })

  // Fallback to static woka.json during initial catalog migration
  if (sets.length === 0) {
    const staticData = getWokaData()
    return NextResponse.json(staticData)
  }

  return NextResponse.json(buildWokaListPayload(sets))
}

function parsePlayUri(
  roomUrl: string
): { universeSlug: string; worldSlug: string } | null {
  try {
    const url = new URL(roomUrl)
    // Pattern: /_/<universeSlug>/<worldSlug>/...
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length >= 3 && parts[0] === '_') {
      return { universeSlug: parts[1], worldSlug: parts[2] }
    }
    return null
  } catch {
    return null
  }
}
