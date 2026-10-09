import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { wokaTexturesForMany } from '@/lib/woka-avatar';
import type { WorldChatMembersData } from '@/types/workadventure';

// Wokas are looked up in slices so a world with a very long member list never sends one huge query.
const WOKA_BATCH = 500;

async function wokasFor(userIds: string[], worldId: string) {
  const wokas = new Map<string, { id: string; url: string }[]>();
  for (let from = 0; from < userIds.length; from += WOKA_BATCH) {
    const slice = await wokaTexturesForMany(userIds.slice(from, from + WOKA_BATCH), worldId);
    slice.forEach((layers, userId) => wokas.set(userId, layers));
  }
  return wokas;
}

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const playUri = searchParams.get('playUri');
    const searchText = searchParams.get('searchText') || '';
    
    if (!playUri) {
      return NextResponse.json(
        { error: 'playUri is required' },
        { status: 400 }
      );
    }
    
    const { universe, world } = parsePlayUri(playUri);
    
    // Find world
    const worldData = await prisma.world.findFirst({
      where: {
        slug: world,
        universe: {
          slug: universe,
        },
      },
    });
    
    if (!worldData) {
      return NextResponse.json(
        { error: 'World not found' },
        { status: 404 }
      );
    }
    
    // Get world members with Matrix chat IDs (never the System account)
    const members = await prisma.worldMember.findMany({
      where: {
        worldId: worldData.id,
        user: {
          AND: [
            NOT_SYSTEM_USER,
            { matrixChatId: { not: null } },
            searchText ? {
              OR: [
                { name: { contains: searchText, mode: 'insensitive' } },
                { email: { contains: searchText, mode: 'insensitive' } },
              ],
            } : undefined,
          ].filter(Boolean) as any,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            uuid: true,
            name: true,
            email: true,
            matrixChatId: true,
          },
        },
      },
    });
    
    // Each member's saved Woka, so the chat can draw people who are away, not only the ones on the map. Never fails
    // the list: without one the game draws its default Woka or a letter.
    const wokas = await wokasFor(members.map((m: typeof members[0]) => m.user.id), worldData.id)
      .catch(() => new Map<string, { id: string; url: string }[]>());

    const response: WorldChatMembersData = {
      total: members.length,
      members: members.map((m: typeof members[0]) => ({
        uuid: m.user.uuid,
        wokaName: m.user.name || '',
        email: m.user.email,
        chatId: m.user.matrixChatId,
        tags: m.tags,
        characterTextures: wokas.get(m.user.id) ?? [],
      })),
    };
    
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/chat/members:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

