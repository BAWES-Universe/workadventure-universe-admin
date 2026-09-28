import { NextRequest, NextResponse } from 'next/server';
import { getViewer, isPrivileged, memberWorldIdsOf } from '@/lib/access-scope';
import { canSeeRoom } from '@/lib/room-visibility';
import { prisma } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const sessionUser = viewer.kind === 'user' ? viewer.user : null;

    const { id } = await params;
    
    // Get all favorites for this user that are rooms
    const favorites = await prisma.favorite.findMany({
      where: {
        userId: id,
        roomId: {
          not: null,
        },
      },
      include: {
        room: {
          include: {
            world: {
              select: {
                id: true,
                name: true,
                slug: true,
                isPublic: true,
                universe: {
                  select: {
                    id: true,
                    name: true,
                    slug: true,
                    isPublic: true,
                    ownerId: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        favoritedAt: 'desc',
      },
    });

    // Someone else's stars only show the rooms the viewer could see anyway; your own stars, and a super admin's view,
    // show everything.
    const seesAll = isPrivileged(viewer) || sessionUser?.id === id;
    const memberWorldIds = seesAll || !sessionUser ? new Set<string>() : await memberWorldIdsOf(sessionUser.id);
    const visible = favorites.filter(
      (f) => f.room !== null && (seesAll || canSeeRoom(f.room, sessionUser, memberWorldIds))
    );

    // Get star counts for all rooms in one query
    const roomIds = visible.map((f) => f.room!.id);

    const starCounts = await prisma.favorite.groupBy({
      by: ['roomId'],
      where: {
        roomId: {
          in: roomIds,
        },
      },
      _count: {
        id: true,
      },
    });

    const starCountMap = new Map(
      starCounts.map((sc) => [sc.roomId!, sc._count.id])
    );

    // Transform to room format with star information
    const starredRooms = visible.map((favorite) => {
      const room = favorite.room!;
      return {
        id: room.id,
        slug: room.slug,
        name: room.name,
        description: room.description,
        mapUrl: room.mapUrl,
        wamUrl: room.wamUrl,
        isPublic: room.isPublic,
        createdAt: room.createdAt,
        updatedAt: room.updatedAt,
        world: {
          id: room.world.id,
          name: room.world.name,
          slug: room.world.slug,
          universe: { id: room.world.universe.id, name: room.world.universe.name, slug: room.world.universe.slug },
        },
        isStarred: true,
        starCount: starCountMap.get(room.id) || 0,
        favoritedAt: favorite.favoritedAt,
      };
    });

    return NextResponse.json({
      rooms: starredRooms,
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error fetching starred rooms:', error);
    return NextResponse.json(
      { error: 'Failed to fetch starred rooms' },
      { status: 500 }
    );
  }
}

