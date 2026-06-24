/**
 * GET /api/admin/avatar-sets/bot-assignable?botId=...
 *
 * Returns avatar sets available for a specific bot's texture picker.
 * All users go through the same scope and entitlement filters.
 */
import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { requireAdminSession } from '@/lib/auth'
import { resolveBotAssignableSets } from '@/lib/avatar-catalog'

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

  const sets = await resolveBotAssignableSets({
    prisma,
    userId,
    worldId,
    universeId,
    membershipTags,
  })

  return NextResponse.json(sets)
}
