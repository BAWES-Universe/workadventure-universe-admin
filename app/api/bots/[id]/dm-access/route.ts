import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { isSuperAdmin } from '@/lib/super-admin';
import { canSeeRoom } from '@/lib/room-visibility';
import { memberWorldIdsOf } from '@/lib/access-scope';

/**
 * GET /api/bots/:id/dm-access?chatId=@alice:example.org
 * Whether the person behind a Matrix ID may message this bot directly.
 *
 * Auth: Service token only (the bot server asks when someone invites or messages a bot).
 * Rule: the same people who can reach the bot's room may DM it. They need an Orbit account linked to that Matrix ID,
 * the bot must be enabled, they must be able to see the room, and they must not be banned from its world or universe.
 * Returns: { allowed, reason, user } where user carries the person's WorkAdventure uuid and name when allowed.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const { id } = await params;
    const chatId = request.nextUrl.searchParams.get('chatId')?.trim();
    if (!chatId) {
      return NextResponse.json({ error: 'chatId is required' }, { status: 400 });
    }

    const bot = await prisma.bot.findUnique({
      where: { id },
      select: {
        enabled: true,
        room: {
          select: {
            isPublic: true,
            world: {
              select: {
                id: true,
                isPublic: true,
                universeId: true,
                universe: { select: { isPublic: true, ownerId: true } },
              },
            },
          },
        },
      },
    });
    if (!bot) {
      return NextResponse.json({ allowed: false, reason: 'bot_not_found', user: null });
    }
    if (!bot.enabled) {
      return NextResponse.json({ allowed: false, reason: 'bot_disabled', user: null });
    }

    // The game reports each person's Matrix ID when they connect, so two accounts can claim the same one. Refuse
    // rather than guess, or one person's messages would land in the other's memory with the bot.
    const people = await prisma.user.findMany({
      where: { matrixChatId: chatId },
      take: 2,
      select: { id: true, uuid: true, name: true, email: true, isGuest: true },
    });
    if (people.length === 0) {
      return NextResponse.json({ allowed: false, reason: 'unknown_person', user: null });
    }
    if (people.length > 1) {
      return NextResponse.json({ allowed: false, reason: 'ambiguous_person', user: null });
    }
    const person = people[0];

    const world = bot.room.world;
    const ban = await prisma.ban.findFirst({
      where: {
        isActive: true,
        userId: person.id,
        AND: [
          { OR: [{ worldId: world.id }, { universeId: world.universeId }, { worldId: null, universeId: null }] },
          { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        ],
      },
      select: { id: true },
    });
    if (ban) {
      return NextResponse.json({ allowed: false, reason: 'banned', user: null });
    }

    const viewer = {
      id: person.id,
      uuid: person.uuid,
      email: person.email,
      name: person.name,
      tags: [],
      isSuperAdmin: isSuperAdmin(person.email),
    };
    const memberWorldIds = await memberWorldIdsOf(person.id, [world.id]);
    if (!canSeeRoom(bot.room, viewer, memberWorldIds)) {
      return NextResponse.json({ allowed: false, reason: 'no_room_access', user: null });
    }

    return NextResponse.json({
      allowed: true,
      reason: null,
      user: { uuid: person.uuid, name: person.name, isGuest: person.isGuest },
    });
  } catch (error) {
    console.error('Error checking bot DM access:', error);
    return NextResponse.json({ error: 'Failed to check DM access' }, { status: 500 });
  }
}
