import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

// GET /api/admin/rooms/previous - Get previous location for current user (visited within 1 hour before current location)
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const currentRoomId = searchParams.get('currentRoomId');

    if (!currentRoomId) {
      return NextResponse.json({ error: 'currentRoomId is required' }, { status: 400 });
    }

    // Get the user's most recent access to ANY room (should be current room if they're in it)
    // This ensures we use the most recent activity as reference
    const mostRecentAccess = await prisma.roomAccess.findFirst({
      where: {
        OR: [
          { userId: sessionUser.id },
          { userUuid: sessionUser.uuid },
        ],
        roomId: currentRoomId,
      },
      orderBy: { accessedAt: 'desc' },
    });

    if (!mostRecentAccess) {
      return NextResponse.json({ room: null });
    }

    const currentTime = mostRecentAccess.accessedAt;
    const now = new Date();
    
    // Only show previous location if current access is recent (within last 2 hours)
    // This prevents showing old previous locations
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    if (currentTime < twoHoursAgo) {
      return NextResponse.json({ room: null });
    }

    const oneHourAgo = new Date(currentTime.getTime() - 60 * 60 * 1000); // 1 hour before current access

    // Get the user's most recent access before the current one (within 1 hour)
    const previousAccess = await prisma.roomAccess.findFirst({
      where: {
        OR: [
          { userId: sessionUser.id },
          { userUuid: sessionUser.uuid },
        ],
        roomId: { not: currentRoomId }, // Don't include current room
        accessedAt: {
          gte: oneHourAgo,
          lt: currentTime, // Before current access
        },
      },
      include: {
        room: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            mapUrl: true,
            world: {
              select: {
                id: true,
                name: true,
                slug: true,
                universe: {
                  select: {
                    id: true,
                    name: true,
                    slug: true,
                  },
                },
              },
            },
            _count: {
              select: {
                favorites: true,
              },
            },
          },
        },
      },
      orderBy: { accessedAt: 'desc' },
    });

    if (!previousAccess || !previousAccess.room) {
      return NextResponse.json({ room: null });
    }

    const room = previousAccess.room;
    const world = room.world;
    const universe = world.universe;

    // Skip default/default/default room
    if (universe.slug === 'default' && world.slug === 'default' && room.slug === 'default') {
      return NextResponse.json({ room: null });
    }

    return NextResponse.json({
      room: {
        id: room.id,
        name: room.name,
        slug: room.slug,
        description: room.description,
        mapUrl: room.mapUrl,
        world: {
          id: world.id,
          name: world.name,
          slug: world.slug,
          universe: {
            id: universe.id,
            name: universe.name,
            slug: universe.slug,
          },
        },
        _count: {
          favorites: room._count?.favorites ?? 0,
        },
        accessedAt: previousAccess.accessedAt,
      },
    });
  } catch (error) {
    console.error('Error fetching previous location:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

