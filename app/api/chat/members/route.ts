import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import type { WorldChatMembersData } from '@/types/workadventure';

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
    
    // Get world members with Matrix chat IDs
    const members = await prisma.worldMember.findMany({
      where: {
        worldId: worldData.id,
        user: {
          AND: [
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
            uuid: true,
            name: true,
            email: true,
            matrixChatId: true,
          },
        },
      },
    });
    
    const response: WorldChatMembersData = {
      total: members.length,
      members: members.map((m: typeof members[0]) => ({
        uuid: m.user.uuid,
        wokaName: m.user.name || '',
        email: m.user.email,
        chatId: m.user.matrixChatId,
        tags: m.tags,
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

