/**
 * GET /api/woka/mine?roomUrl=...&uuid=...
 *
 * What the game needs to show a signed-in person their Woka in one world: the Woka they wear now and whether this world
 * allows it, the one to suggest instead, their Recent list and their companion. A guest, or a uuid we don't know, gets 404.
 *
 * Auth: Requires ADMIN_API_TOKEN in Authorization header (sent by the play server).
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { parsePlayUri } from '@/lib/utils'
import { buildWokaMine } from '@/lib/woka-mine'

export async function GET(request: NextRequest) {
  try {
    requireAuth(request)

    const searchParams = new URL(request.url).searchParams
    const roomUrl = searchParams.get('roomUrl')
    const uuid = searchParams.get('uuid')
    if (!roomUrl || !uuid) {
      return NextResponse.json({ error: 'roomUrl and uuid are required' }, { status: 400 })
    }

    let universeSlug: string
    let worldSlug: string
    try {
      const parsed = parsePlayUri(roomUrl)
      universeSlug = parsed.universe
      worldSlug = parsed.world
    } catch {
      return NextResponse.json({ error: 'Invalid roomUrl format' }, { status: 400 })
    }

    const [user, world] = await Promise.all([
      prisma.user.findUnique({ where: { uuid }, select: { id: true, isGuest: true } }),
      prisma.world.findFirst({
        where: { slug: worldSlug, universe: { slug: universeSlug } },
        select: { id: true, universeId: true },
      }),
    ])
    if (!user || user.isGuest || !world) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 })
    }

    const member = await prisma.worldMember.findUnique({
      where: { userId_worldId: { userId: user.id, worldId: world.id } },
      select: { tags: true },
    })
    const mine = await buildWokaMine(user.id, {
      worldId: world.id,
      universeId: world.universeId,
      userId: user.id,
      membershipTags: member?.tags ?? [],
    })
    return NextResponse.json(mine)
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Error in /api/woka/mine:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
