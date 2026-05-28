/**
 * POST /api/save-textures
 *
 * Called by the WA play server when a user selects their avatar textures.
 * Persists to the user_avatars table so the selection survives reconnection.
 *
 * Request body: { playUri, userIdentifier, textures: string[] }
 * Auth: ADMIN_API_TOKEN in Authorization header
 * Response: 204 on success
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { parsePlayUri } from '@/lib/utils'

export async function POST(request: NextRequest) {
  try {
    requireAuth(request)

    const body = await request.json()
    const { playUri, userIdentifier, textures } = body

    if (!playUri || !userIdentifier || !Array.isArray(textures)) {
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

    // Upsert user_avatars record (unique constraint on userId + worldId)
    await prisma.userAvatar.upsert({
      where: {
        userId_worldId: { userId: user.id, worldId },
      },
      create: {
        userId: user.id,
        worldId,
        textureIds: textures,
      },
      update: {
        textureIds: textures,
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
