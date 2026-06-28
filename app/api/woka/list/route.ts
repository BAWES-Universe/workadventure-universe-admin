/**
 * GET /api/woka/list?roomUrl=...&uuid=...
 *
 * Returns the woka picker payload for a player.
 * Resolves scope + entitlement via the avatar catalog engine.
 * Falls back to static config/woka.json when no active catalog sets exist
 * (zero-downtime migration path).
 *
 * Auth: Requires ADMIN_API_TOKEN in Authorization header (sent by the play server).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import {
  resolvePickerSets,
  resolveBotAssignableSets,
  buildWokaListPayload,
} from '@/lib/avatar-catalog'
import { getWokaList } from '@/lib/wokas'

export async function GET(request: NextRequest) {
  try {
    requireAuth(request)

    const searchParams = new URL(request.url).searchParams
    const roomUrl = searchParams.get('roomUrl')
    const uuid = searchParams.get('uuid')
    const context = searchParams.get('context')
    const botId = searchParams.get('botId')

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

    const playServiceUrl = process.env.PLAY_URL || 'http://play.workadventure.localhost'

    let sets

    if (context === 'bot') {
      // Bot texture picker — use resolveBotAssignableSets so hidden sets appear
      sets = await resolveBotAssignableSets({
        prisma,
        userId: userId ?? '',
        worldId,
        universeId,
        membershipTags,
      })
    } else {
      sets = await resolvePickerSets({
        prisma,
        worldId,
        universeId,
        userId,
        membershipTags,
      })
    }

    // Fallback to static woka.json during initial catalog migration
    if (sets.length === 0) {
      const staticData = getWokaList(playServiceUrl)
      return NextResponse.json(staticData)
    }

    return NextResponse.json(buildWokaListPayload(sets, playServiceUrl))
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      )
    }
    console.error('Error in /api/woka/list:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}

function parsePlayUri(
  roomUrl: string
): { universeSlug: string; worldSlug: string } | null {
  try {
    const url = new URL(roomUrl)
    // Pattern: /_/<universeSlug>/<worldSlug>/...
    const parts = url.pathname.split('/').filter(Boolean)
    if (parts.length >= 3 && (parts[0] === '_' || parts[0] === '@')) {
      return { universeSlug: parts[1], worldSlug: parts[2] }
    }
    return null
  } catch {
    return null
  }
}
