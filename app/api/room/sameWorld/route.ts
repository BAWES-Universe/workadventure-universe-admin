import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { parsePlayUri, buildPlayUri } from '@/lib/utils';
import { prisma } from '@/lib/db';
import type { ShortMapDescriptionList } from '@/types/workadventure';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const roomUrl = searchParams.get('roomUrl');
    const tags = searchParams.get('tags')?.split(',') || [];
    const bypassTagFilter = searchParams.get('bypassTagFilter') === 'true';
    
    if (!roomUrl) {
      return NextResponse.json(
        { error: 'roomUrl is required' },
        { status: 400 }
      );
    }
    
    const { universe, world } = parsePlayUri(roomUrl);
    const baseUrl = new URL(roomUrl).origin;
    
    // Find world
    const worldData = await prisma.world.findFirst({
      where: {
        slug: world,
        universe: {
          slug: universe,
        },
      },
      include: {
        rooms: {
          where: {
            isPublic: true,
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
    
    // Filter rooms by tags if needed
    let filteredRooms = worldData.rooms;
    if (!bypassTagFilter && tags.length > 0) {
      // TODO: Implement tag-based filtering if you add tags to rooms
      // For now, return all rooms
    }
    
    const response: ShortMapDescriptionList = filteredRooms.map(room => ({
      name: room.name,
      roomUrl: buildPlayUri(baseUrl, universe, world, room.slug),
      wamUrl: buildPlayUri(baseUrl, universe, world, room.slug),
    }));
    
    return NextResponse.json(response);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }
    
    console.error('Error in /api/room/sameWorld:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

