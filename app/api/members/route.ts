import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import type { MemberData } from '@/types/workadventure';

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
    
    // Get members
    const members = await prisma.worldMember.findMany({
      where: {
        worldId: worldData.id,
        user: searchText ? {
          OR: [
            { name: { contains: searchText, mode: 'insensitive' } },
            { email: { contains: searchText, mode: 'insensitive' } },
          ],
        } : undefined,
      },
      include: {
        user: {
          select: {
            uuid: true,
            name: true,
            email: true,
          },
        },
      },
    });
    
    const memberData: MemberData[] = members.map(m => ({
      uuid: m.user.uuid,
      name: m.user.name || undefined,
      email: m.user.email || undefined,
      tags: m.tags,
      visitCardUrl: null,
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

