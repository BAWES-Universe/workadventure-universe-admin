import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

// GET /api/admin/users/[id] - Get a single user
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
    const user = await prisma.user.findUnique({
      where: { id },
      include: {
        ownedUniverses: {
          select: {
            id: true,
            slug: true,
            name: true,
            description: true,
            thumbnailUrl: true,
            isPublic: true,
            createdAt: true,
            _count: {
              select: {
                worlds: true,
              },
            },
            worlds: {
              select: {
                _count: {
                  select: {
                    rooms: true,
                    members: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        },
        worldMemberships: {
          include: {
            world: {
              select: {
                id: true,
                slug: true,
                name: true,
                description: true,
                thumbnailUrl: true,
                universe: {
                  select: {
                    id: true,
                    slug: true,
                    name: true,
                  },
                },
                _count: {
                  select: {
                    rooms: true,
                    members: true,
                  },
                },
              },
            },
          },
          orderBy: { joinedAt: 'desc' },
        },
        _count: {
          select: {
            ownedUniverses: true,
            worldMemberships: true,
            bans: true,
            favorites: true,
            avatars: true,
          },
        },
      },
    });
    
    if (!user) {
      return NextResponse.json(
        { error: 'User not found' },
        { status: 404 }
      );
    }
    
    // Calculate total rooms, members, and favorites counts for each universe
    const universeIds = user.ownedUniverses.map((u: any) => u.id);
    const favoritesByUniverse = universeIds.length > 0
      ? await prisma.favorite.groupBy({
          by: ['universeId'],
          where: {
            universeId: { in: universeIds },
          },
          _count: {
            id: true,
          },
        })
      : [];
    
    const favoritesCountMap = new Map(
      favoritesByUniverse.map((fb) => [fb.universeId!, fb._count.id])
    );

    // Calculate favorites counts for all worlds in worldMemberships
    const worldIds = user.worldMemberships.map((wm: any) => wm.world.id);
    const favoritesByWorld = worldIds.length > 0
      ? await prisma.favorite.groupBy({
          by: ['worldId'],
          where: {
            worldId: { in: worldIds },
          },
          _count: {
            id: true,
          },
        })
      : [];
    
    const worldFavoritesCountMap = new Map(
      favoritesByWorld.map((fb) => [fb.worldId!, fb._count.id])
    );

    const userWithCounts = {
      ...user,
      ownedUniverses: user.ownedUniverses.map((universe: any) => {
        const totalRooms = universe.worlds?.reduce((sum: number, world: any) => sum + (world._count?.rooms || 0), 0) || 0;
        const totalMembers = universe.worlds?.reduce((sum: number, world: any) => sum + (world._count?.members || 0), 0) || 0;
        const totalFavorites = favoritesCountMap.get(universe.id) || 0;
        return {
          ...universe,
          _count: {
            ...universe._count,
            rooms: totalRooms,
            members: totalMembers,
            favorites: totalFavorites,
          },
        };
      }),
      worldMemberships: user.worldMemberships.map((membership: any) => ({
        ...membership,
        world: {
          ...membership.world,
          _count: {
            ...membership.world._count,
            favorites: worldFavoritesCountMap.get(membership.world.id) || 0,
          },
        },
      })),
    };
    
    return NextResponse.json(userWithCounts);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error fetching user:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

