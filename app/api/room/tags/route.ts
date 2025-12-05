import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const roomUrl = searchParams.get('roomUrl');
    
    if (!roomUrl) {
      return NextResponse.json(
        { error: 'roomUrl is required' },
        { status: 400 }
      );
    }
    
    const { universe, world } = parsePlayUri(roomUrl);
    
    // Find world
    const worldData = await prisma.world.findFirst({
      where: {
        slug: world,
        universe: {
          slug: universe,
        },
      },
      include: {
        members: {
          select: {
            tags: true,
          },
        },
      },
    });
    
    if (!worldData) {
      return NextResponse.json(
        { error: 'World not found' },
        { status: 404 }
      );
    }
    
    // Collect all unique tags from world members
    const allTags = new Set<string>();
    worldData.members.forEach(member => {
      member.tags.forEach(tag => allTags.add(tag));
    });
    
    return NextResponse.json(Array.from(allTags));
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/room/tags:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

