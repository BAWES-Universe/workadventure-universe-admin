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
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    
    const skip = (page - 1) * limit;
    
    // Build where clause
    const where: any = {
      userId: id,
    };
    
    if (startDate || endDate) {
      where.accessedAt = {};
      if (startDate) where.accessedAt.gte = new Date(startDate);
      if (endDate) where.accessedAt.lte = new Date(endDate);
    }
    
    // Get total count
    const total = await prisma.roomAccess.count({ where });
    
    // Get paginated access history
    const accesses = await prisma.roomAccess.findMany({
      where,
      include: {
        universe: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
        world: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
        room: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
      },
      orderBy: { accessedAt: 'desc' },
      skip,
      take: limit,
    });
    
    // Get summary stats
    const firstAccess = await prisma.roomAccess.findFirst({
      where,
      orderBy: { accessedAt: 'asc' },
      select: { accessedAt: true },
    });
    
    const lastAccess = await prisma.roomAccess.findFirst({
      where,
      orderBy: { accessedAt: 'desc' },
      select: { accessedAt: true },
    });
    
    // Get most visited rooms
    const roomStats = await prisma.roomAccess.groupBy({
      by: ['roomId'],
      where,
      _count: { roomId: true },
      orderBy: { _count: { roomId: 'desc' } },
      take: 5,
    });
    
    const roomIds = roomStats.map(r => r.roomId);
    const rooms = await prisma.room.findMany({
      where: { id: { in: roomIds } },
      select: {
        id: true,
        slug: true,
        name: true,
        world: {
          select: {
            slug: true,
            name: true,
            universe: {
              select: {
                slug: true,
                name: true,
              },
            },
          },
        },
      },
    });
    
    const mostVisitedRooms = roomStats.map(stat => {
      const room = rooms.find(r => r.id === stat.roomId);
      return {
        roomId: stat.roomId,
        count: stat._count.roomId,
        room: room ? {
          name: room.name,
          slug: room.slug,
          world: room.world.name,
          universe: room.world.universe.name,
        } : null,
      };
    });
    
    return NextResponse.json({
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      firstAccess: firstAccess?.accessedAt || null,
      lastAccess: lastAccess?.accessedAt || null,
      mostVisitedRooms,
      accesses: accesses.map(access => ({
        id: access.id,
        accessedAt: access.accessedAt,
        ipAddress: access.ipAddress,
        isGuest: access.isGuest,
        isAuthenticated: access.isAuthenticated,
        hasMembership: access.hasMembership,
        membershipTags: access.membershipTags,
        universe: access.universe,
        world: access.world,
        room: access.room,
        playUri: access.playUri,
      })),
    });
  } catch (error) {
    console.error('Error fetching user analytics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch user analytics' },
      { status: 500 }
    );
  }
}

