import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Check if using admin token or session
    const authHeader = request.headers.get('authorization');
    const isAdminToken = authHeader?.startsWith('Bearer ') && 
      authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;
    
    if (!isAdminToken) {
      // Try to get user from session
      const { getSessionUser } = await import('@/lib/auth-session');
      const sessionUser = await getSessionUser(request);
      if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
    } else {
      // Admin token - require it
      requireAuth(request);
    }
    
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
      { error: 'Failed to fetch starred rooms' },
      { status: 500 }
    );
  }
}

