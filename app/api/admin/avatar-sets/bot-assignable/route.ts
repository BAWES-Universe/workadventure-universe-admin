/**
 * GET /api/admin/avatar-sets/bot-assignable?botId=...
 *
 * Returns avatar sets available for a specific bot's texture picker.
 *
 * Super admins see every active set regardless of scope/visibility.
 * Regular users see only sets scoped to the bot's world + accessible
 * via public visibility, assign_to_bot policy, or direct grant.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession } from '@/lib/auth'
import { resolveBotAssignableSets } from '@/lib/avatar-catalog'
import { isSuperAdmin } from '@/lib/super-admin'

export async function GET(request: NextRequest) {
  const { userId } = await requireAdminSession()

  const { searchParams } = new URL(request.url)
  const botId = searchParams.get('botId')

  if (!botId) {
    return NextResponse.json(
      { error: 'botId query parameter is required' },
      { status: 400 }
    )
  }

  // Look up the bot to get its world/universe scope
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: {
      room: {
        select: {
          worldId: true,
          world: {
            select: { universeId: true },
          },
        },
      },
    },
  })

  if (!bot) {
    return NextResponse.json({ error: 'Bot not found' }, { status: 404 })
  }

  if (!bot.room) {
    return NextResponse.json(
      { error: 'Bot is not assigned to any room' },
      { status: 400 }
    )
  }

  if (!bot.room.world) {
    return NextResponse.json(
      { error: 'Bot room is not associated with any world' },
      { status: 400 }
    )
  }

  const worldId = bot.room.worldId
  const universeId = bot.room.world.universeId

  // Resolve membership tags for this user in the bot's world
  const member = await prisma.worldMember.findUnique({
    where: {
      userId_worldId: { userId, worldId },
    },
    select: { tags: true },
  })
  const membershipTags = member?.tags ?? []

  // Check if the caller is a super admin
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  })
  const superAdmin = !!user && isSuperAdmin(user.email)

  const sets = await resolveBotAssignableSets({
    prisma,
    userId,
    isSuperAdmin: superAdmin,
    worldId,
    universeId,
    membershipTags,
  })

  return NextResponse.json(sets)
}
