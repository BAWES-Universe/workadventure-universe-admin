/**
 * POST /api/save-textures
 *
 * Called by the WA play server when a user selects their avatar textures.
 * A person wears one Woka everywhere: the last one they pick. The pick is refused (422 WOKA_NOT_ALLOWED, nothing saved)
 * when it can't be worn in the world it is picked in. Otherwise it is recorded in the person's outfits (user_outfits,
 * which holds the Woka they wear now and their Recent list) and kept in user_avatars as before.
 *
 * Request body: { playUri, userIdentifier, textures: string[] }
 * Auth: ADMIN_API_TOKEN in Authorization header
 * Response: 204 on success, 422 { code: "WOKA_NOT_ALLOWED" } when the Woka can't be worn there
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { parsePlayUri } from '@/lib/utils'
import { recordOutfitPick } from '@/lib/user-outfits'
import { wearableContextFor, wearableHere } from '@/lib/woka-wearable'

export async function POST(request: NextRequest) {
  try {
    requireAuth(request)

    const body = await request.json()
    const { playUri, userIdentifier, textures } = body

    if (!playUri || !userIdentifier || !Array.isArray(textures) || !textures.every((id) => typeof id === 'string')) {
      return NextResponse.json(
        { error: 'playUri, userIdentifier, and textures (array) are required' },
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

    // The same check as on room entry: a pick the door would refuse is refused here, before anything is saved.
    const context = await wearableContextFor(user.id, worldId)
    if (!context || !(await wearableHere(textures, context)).wearable) {
      return NextResponse.json({ code: 'WOKA_NOT_ALLOWED' }, { status: 422 })
    }

    await recordOutfitPick(user.id, textures)

    // Upsert user_avatars record (unique constraint on userId + worldId)
    await prisma.userAvatar.upsert({
      where: {
        userId_worldId: { userId: user.id, worldId },
      },
      create: {
        userId: user.id,
        worldId,
        textureIds: textures,
        outfitUpdatedAt: new Date(),
      },
      update: {
        textureIds: textures,
        outfitUpdatedAt: new Date(),
      },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Error in /api/save-textures:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
