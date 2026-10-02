import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { hiddenSystemOwnerId, notSystemUniverse } from '@/lib/system-user';

// GET /api/admin/rooms/previous - Get previous location for current user (visited within 1 hour before current location)
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    // The room you're in: by id when Orbit knows it, and by its play link either way (a start map Orbit doesn't
    // know, or whose visit wasn't recorded, still has one).
    const currentRoomId = searchParams.get('currentRoomId');
    const playUri = searchParams.get('playUri');

    if (!currentRoomId && !playUri) {
      return NextResponse.json({ error: 'currentRoomId or playUri is required' }, { status: 400 });
    }

    const you = [{ userId: sessionUser.id }, { userUuid: sessionUser.uuid }];
    const now = new Date();

    // Measured from when you arrived here if that was in the last 2 hours, otherwise from now, so it never reaches
    // further back than that. Arriving isn't always recorded (a map Orbit doesn't know, a visit that failed to log),
    // and the room before it must still show.
    const arrival = currentRoomId
      ? await prisma.roomAccess.findFirst({
          where: { OR: you, roomId: currentRoomId },
          orderBy: { accessedAt: 'desc' },
        })
      : null;
    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const reference = arrival && arrival.accessedAt >= twoHoursAgo ? arrival.accessedAt : now;
    const oneHourBefore = new Date(reference.getTime() - 60 * 60 * 1000);

    // The latest other room you were in, from an hour before you arrived up to now, never in System's spaces once
    // they are hidden. Up to now, not up to your arrival: the visit before this one can be recorded a moment late.
    // A room Orbit doesn't know has no visits of its own, so only a known room needs leaving out.
    const hidden = await hiddenSystemOwnerId();
    const previousAccess = await prisma.roomAccess.findFirst({
      where: {
        OR: you,
        ...(currentRoomId ? { roomId: { not: currentRoomId } } : {}),
        ...(hidden ? { universe: notSystemUniverse(hidden) } : {}),
        accessedAt: {
          gte: oneHourBefore,
          lte: now,
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

