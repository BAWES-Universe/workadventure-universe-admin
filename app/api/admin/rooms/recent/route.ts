import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

// GET /api/admin/rooms/recent - Get recent rooms for the current user
export async function GET(request: NextRequest) {
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

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '2', 10);
    const excludeRoomId = searchParams.get('excludeRoomId');

    const accesses = await prisma.roomAccess.findMany({
      where: {},
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
      take: 50, // Fetch more to ensure unique rooms
    });

    const seen = new Set<string>();
    const recent: {
      roomId: string;
      roomName: string;
      roomSlug: string;
      roomDescription: string | null;
      roomMapUrl: string | null;
      roomFavorites: number;
      worldId: string;
      worldName: string;
      worldSlug: string;
      universeId: string;
      universeName: string;
      universeSlug: string;
      accessedAt: Date;
    }[] = [];

    for (const access of accesses) {
      const room = access.room;
      const world = room?.world;
      const universe = world?.universe;
      if (!room || !world || !universe) continue;
      
      // Skip default/default/default room
      if (universe.slug === 'default' && world.slug === 'default' && room.slug === 'default') {
        continue;
      }

      // Skip if this is the room to exclude
      if (excludeRoomId && room.id === excludeRoomId) {
        continue;
      }
      
      if (seen.has(room.id)) continue;
      seen.add(room.id);

      recent.push({
        roomId: room.id,
        roomName: room.name,
        roomSlug: room.slug,
        roomDescription: room.description,
        roomMapUrl: room.mapUrl,
        roomFavorites: room._count?.favorites ?? 0,
        worldId: world.id,
        worldName: world.name,
        worldSlug: world.slug,
        universeId: universe.id,
        universeName: universe.name,
        universeSlug: universe.slug,
        accessedAt: access.accessedAt,
      });

      if (recent.length >= limit) break;
    }

    return NextResponse.json({ rooms: recent });
  } catch (error) {
    console.error('Error fetching recent rooms:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

