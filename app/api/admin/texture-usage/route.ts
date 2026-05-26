/**
 * GET /api/admin/texture-usage?textureId=xxx&type=layer|companion
 *
 * Returns how many users currently have this texture equipped.
 * Queries the user_avatars table which tracks per-user texture selections.
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAdminSession } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(request: NextRequest) {
  try {
    await requireAdminSession()

    const textureId = request.nextUrl.searchParams.get('textureId')
    const type = request.nextUrl.searchParams.get('type') || 'layer'

    if (!textureId) {
      return NextResponse.json({ error: 'textureId is required' }, { status: 400 })
    }

    let count: number

    if (type === 'companion') {
      count = await prisma.userAvatar.count({
        where: { companionTextureId: textureId },
      })
    } else {
      // Layer type — textureId appears in the texture_ids array
      count = await prisma.userAvatar.count({
        where: { textureIds: { has: textureId } },
      })
    }

    return NextResponse.json({ textureId, type, userCount: count })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Error in /api/admin/texture-usage:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
