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
    
    // Get total accesses for this world
    const totalAccesses = await prisma.roomAccess.count({
      where: { worldId: id },
    });
    
    // Get unique users
    const uniqueUserIds = await prisma.roomAccess.findMany({
      where: {
        worldId: id,
        userId: { not: null },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    
    const uniqueUserUuids = await prisma.roomAccess.findMany({
      where: {
        worldId: id,
        userUuid: { not: null },
      },
      select: { userUuid: true },
      distinct: ['userUuid'],
    });
    
    const uniqueUsers = new Set([
      ...uniqueUserIds.map(u => u.userId).filter(Boolean),
      ...uniqueUserUuids.map(u => u.userUuid).filter(Boolean),
    ]).size;
    
    // Get unique IPs
    const uniqueIps = await prisma.roomAccess.findMany({
      where: { worldId: id },
      select: { ipAddress: true },
      distinct: ['ipAddress'],
    });
    
    // Get most active room
    const roomStats = await prisma.roomAccess.groupBy({
      by: ['roomId'],
      where: { worldId: id },
      _count: { roomId: true },
      orderBy: { _count: { roomId: 'desc' } },
      take: 1,
    });
    
    let mostActiveRoom = null;
    if (roomStats.length > 0) {
      const room = await prisma.room.findUnique({
        where: { id: roomStats[0].roomId },
        select: {
          id: true,
          slug: true,
          name: true,
        },
      });
      if (room) {
        mostActiveRoom = {
          ...room,
          accessCount: roomStats[0]._count.roomId,
        };
      }
    }
    
    // Get recent activity (last 20 accesses)
    const recentActivity = await prisma.roomAccess.findMany({
      where: { worldId: id },
      include: {
        room: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
      },
      orderBy: { accessedAt: 'desc' },
      take: 20,
    });
    
    // Get last visited by current user (if session user exists)
    let lastVisitedByUser = null;
    if (!isAdminToken) {
      const { getSessionUser } = await import('@/lib/auth-session');
      const sessionUser = await getSessionUser(request);
      if (sessionUser) {
        const userAccess = await prisma.roomAccess.findFirst({
          where: {
            worldId: id,
            OR: [
              { userId: sessionUser.id },
              { userUuid: sessionUser.uuid },
            ],
          },
          orderBy: { accessedAt: 'desc' },
        });
        if (userAccess) {
          lastVisitedByUser = {
            accessedAt: userAccess.accessedAt,
            userId: userAccess.userId,
            userUuid: userAccess.userUuid,
          };
        }
      }
    }
    
    // Get last visited overall (most recent access by anyone)
    const lastVisitedOverall = await prisma.roomAccess.findFirst({
      where: { worldId: id },
      orderBy: { accessedAt: 'desc' },
      select: {
        accessedAt: true,
        userId: true,
        userUuid: true,
        userName: true,
        userEmail: true,
      },
    });
    
    return NextResponse.json({
      totalAccesses,
      uniqueUsers,
      uniqueIPs: uniqueIps.length,
      mostActiveRoom,
      lastVisitedByUser,
      lastVisitedOverall: lastVisitedOverall ? {
        accessedAt: lastVisitedOverall.accessedAt,
        userId: lastVisitedOverall.userId,
        userUuid: lastVisitedOverall.userUuid,
        userName: lastVisitedOverall.userName,
        userEmail: lastVisitedOverall.userEmail,
      } : null,
      recentActivity: recentActivity.map(access => ({
        id: access.id,
        accessedAt: access.accessedAt,
        userId: access.userId,
        userName: access.userName,
        userEmail: access.userEmail,
        userUuid: access.userUuid,
        ipAddress: access.ipAddress,
        isGuest: access.isGuest,
        isAuthenticated: access.isAuthenticated,
        hasMembership: access.hasMembership,
        membershipTags: access.membershipTags,
        room: access.room,
        playUri: access.playUri,
      })),
    });
  } catch (error) {
    console.error('Error fetching world analytics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch world analytics' },
      { status: 500 }
    );
  }
}

