/**
 * POST /api/save-companion-texture
 *
 * Called by the WA play server when a user selects their companion.
 * A person wears one companion everywhere: the last one they pick (null = none, always allowed). The pick is refused
 * (422 WOKA_NOT_ALLOWED, nothing saved) when it can't be worn in the world it is picked in. Otherwise it is saved on the
 * person (users.companion_texture_id) and kept in user_avatars as before.
 *
 * Request body: { playUri, userIdentifier, texture: string | null }
 * Auth: ADMIN_API_TOKEN in Authorization header
 * Response: 204 on success, 422 { code: "WOKA_NOT_ALLOWED" } when the companion can't be worn there
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { parsePlayUri } from '@/lib/utils'
import { companionWearableHere, wearableContextFor } from '@/lib/woka-wearable'

export async function POST(request: NextRequest) {
  try {
    requireAuth(request)

    const body = await request.json()
    const { playUri, userIdentifier, texture } = body

    if (!playUri || !userIdentifier || texture === undefined) {
      return NextResponse.json(
        { error: 'playUri, userIdentifier, and texture are required' },
        { status: 400 }
      )
    }

    // Parse playUri to find the world
    let worldId: string
    try {
      const parsed = parsePlayUri(playUri)
      const world = await prisma.world.findFirst({
        where: {
          slug: parsed.world,
          universe: { slug: parsed.universe },
        },
        select: { id: true },
      })
      if (!world) {
        return NextResponse.json({ error: 'World not found' }, { status: 404 })
      }
      worldId = world.id
    } catch {
      return NextResponse.json({ error: 'Invalid playUri format' }, { status: 400 })
    }

    // Find user by uuid first, then email
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { uuid: userIdentifier },
          { email: userIdentifier },
        ],
      },
    })

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 })
    }

    const context = await wearableContextFor(user.id, worldId)
    if (!context || !(await companionWearableHere(texture, context)).wearable) {
      return NextResponse.json({ code: 'WOKA_NOT_ALLOWED' }, { status: 422 })
    }

    await prisma.user.update({ where: { id: user.id }, data: { companionTextureId: texture } })

    // Upsert user_avatars record (unique constraint on userId + worldId)
    // texture can be null to clear the companion
    await prisma.userAvatar.upsert({
      where: {
        userId_worldId: { userId: user.id, worldId },
      },
      create: {
        userId: user.id,
        worldId,
        companionTextureId: texture,
        textureIds: [], // required field, use empty array if no textures saved yet
      },
      update: {
        companionTextureId: texture,
      },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Error in /api/save-companion-texture:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
