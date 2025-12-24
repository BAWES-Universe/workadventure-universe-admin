import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

/**
 * GET /api/room/info
 * 
 * Public endpoint (no authentication required).
 * Returns room, world, and universe names for a given slug.
 * 
 * Query Parameters:
 * - slug (required): Format "universe/world/room"
 * 
 * Response:
 * {
 *   "roomName": "Lobby",
 *   "worldName": "Office Building",
 *   "universeName": "My Company"
 * }
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const slug = searchParams.get('slug');
    
    if (!slug) {
      return NextResponse.json(
        { error: 'slug parameter is required' },
        { status: 400 }
      );
    }
    
    // Parse slug: "universe/world/room"
    const slugParts = slug.split('/').filter(Boolean);
    
    if (slugParts.length !== 3) {
      return NextResponse.json(
        { error: 'Invalid slug format. Expected: universe/world/room' },
        { status: 400 }
      );
    }
    
    const [universeSlug, worldSlug, roomSlug] = slugParts;
    
    // Query database for room with world and universe
    const roomData = await prisma.room.findFirst({
      where: {
        slug: roomSlug,
        world: {
          slug: worldSlug,
          universe: {
            slug: universeSlug,
          },
        },
      },
      select: {
        name: true,
        world: {
          select: {
            name: true,
            universe: {
              select: {
                name: true,
              },
            },
          },
        },
      },
    });
    
    if (!roomData) {
      return NextResponse.json(
        { error: 'Room not found' },
        { status: 404 }
      );
    }
    
    return NextResponse.json({
      roomName: roomData.name,
      worldName: roomData.world.name,
      universeName: roomData.world.universe.name,
    });
  } catch (error) {
    console.error('Error in /api/room/info:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

