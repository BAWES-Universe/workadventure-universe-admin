import { NextRequest, NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth-session';
import { prisma } from '@/lib/db';

// GET /api/admin/stars/rooms
// Fetch all starred rooms for the current user
export async function GET(request: NextRequest) {
  try {
    const user = await requireSession(request);

    // Get all favorites for this user that are rooms
    const favorites = await prisma.favorite.findMany({
      where: {
        userId: user.id,
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
                universe: {
                  select: {
                    id: true,
                    name: true,
                    slug: true,
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

    // Get star counts for all rooms in one query
    const roomIds = favorites
      .filter((f) => f.room !== null)
      .map((f) => f.room!.id);

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
    const starredRooms = favorites
      .filter((f) => f.room !== null)
      .map((favorite) => {
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
          world: room.world,
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
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

