/**
 * POST /api/save-name
 *
 * Called by the WA play server when a user changes their display name.
 * Persists the name to the User record so it survives reconnection.
 *
 * Request body: { playUri, userIdentifier, name }
 * Auth: ADMIN_API_TOKEN in Authorization header
 * Response: 204 on success
 */

import { NextRequest, NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function POST(request: NextRequest) {
  try {
    requireAuth(request)

    const body = await request.json()
    const { playUri, userIdentifier, name } = body

    if (!playUri || !userIdentifier || name === undefined) {
      return NextResponse.json(
        { error: 'playUri, userIdentifier, and name are required' },
        { status: 400 }
      )
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

    await prisma.user.update({
      where: { id: user.id },
      data: { name },
    })

    return new NextResponse(null, { status: 204 })
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }
    console.error('Error in /api/save-name:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
