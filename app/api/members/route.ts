import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { wokaTexturesForMany } from '@/lib/woka-avatar';
import type { MemberData } from '@/types/workadventure';

const MAX_RESULTS = 20;

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
    
    // Get members (never the System account)
    const members = await prisma.worldMember.findMany({
      where: {
        worldId: worldData.id,
        user: searchText ? {
          AND: [
            NOT_SYSTEM_USER,
            {
              OR: [
                { name: { contains: searchText, mode: 'insensitive' } },
                { email: { contains: searchText, mode: 'insensitive' } },
              ],
            },
          ],
        } : NOT_SYSTEM_USER,
      },
      // A picker shows the first few; typing more narrows it (worlds can have thousands of members).
      take: MAX_RESULTS,
      include: {
        user: {
          select: {
            id: true,
            uuid: true,
            name: true,
            email: true,
          },
        },
      },
    });
    
    // Each member's Woka, so the game's pickers show them like the People list. Never fails the search.
    const wokas = await wokaTexturesForMany(members.map(m => m.user.id), worldData.id)
      .catch(() => new Map<string, { id: string; url: string }[]>());

    // The shape the game reads: `id` (not `uuid`), null when there is no name or email.
    const memberData: MemberData[] = members.map(m => ({
      id: m.user.uuid,
      name: m.user.name || null,
      email: m.user.email || null,
      tags: m.tags,
      visitCardUrl: null,
      characterTextures: wokas.get(m.user.id) ?? [],
    }));
    
    return NextResponse.json(memberData);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/members:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

