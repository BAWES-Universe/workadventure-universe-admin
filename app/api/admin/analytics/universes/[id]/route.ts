import { NextRequest, NextResponse } from 'next/server';
import { getViewer, accessDetailFor, detailForRecord, redactAccess, unauthorizedResponse } from '@/lib/access-scope';
import { prisma } from '@/lib/db';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const viewer = await getViewer(request);
    if (!viewer) {
      return unauthorizedResponse();
    }
    
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const skip = (page - 1) * limit;
    
    // Get total accesses for this universe
    const totalAccesses = await prisma.roomAccess.count({
      where: { universeId: id },
    });
    
    // Get unique users
    const uniqueUserIds = await prisma.roomAccess.findMany({
      where: {
        universeId: id,
        userId: { not: null },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    
    const uniqueUserUuids = await prisma.roomAccess.findMany({
      where: {
        universeId: id,
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
      where: { universeId: id },
      select: { ipAddress: true },
      distinct: ['ipAddress'],
    });
    
    // Get most active world
    const worldStats = await prisma.roomAccess.groupBy({
      by: ['worldId'],
      where: { universeId: id },
      _count: { worldId: true },
      orderBy: { _count: { worldId: 'desc' } },
      take: 1,
    });
    
    let mostActiveWorld = null;
    if (worldStats.length > 0) {
      const world = await prisma.world.findUnique({
        where: { id: worldStats[0].worldId },
        select: {
          id: true,
          slug: true,
          name: true,
        },
      });
      if (world) {
        mostActiveWorld = {
          ...world,
          accessCount: worldStats[0]._count.worldId,
        };
      }
    }
    
    // Get recent activity with pagination
    const recentActivity = await prisma.roomAccess.findMany({
      where: { universeId: id },
      include: {
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
    
    // Get total count for pagination
    const totalRecentActivity = await prisma.roomAccess.count({
      where: { universeId: id },
    });
    
    // Get last visited by current user (if session user exists)
    let lastVisitedByUser = null;
    if (viewer.kind === 'user') {
      const sessionUser = viewer.user;
      const userAccess = await prisma.roomAccess.findFirst({
        where: {
          universeId: id,
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
    
    // Per-visitor detail depends on the viewer: privileged viewers see
    // everything, managers of this scope see who visited (without email or
    // IP address), everyone else only when and where visits happened.
    const detail = await accessDetailFor(viewer, { universeId: id });
    
    // Get last visited overall (most recent access by anyone)
    const lastVisitedOverall = await prisma.roomAccess.findFirst({
      where: { universeId: id },
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
      mostActiveWorld,
      lastVisitedByUser,
      lastVisitedOverall: lastVisitedOverall ? redactAccess({
        accessedAt: lastVisitedOverall.accessedAt,
        userId: lastVisitedOverall.userId,
        userUuid: lastVisitedOverall.userUuid,
        userName: lastVisitedOverall.userName,
        userEmail: lastVisitedOverall.userEmail,
      }, detailForRecord(viewer, lastVisitedOverall, detail)) : null,
      recentActivity: recentActivity.map(access => redactAccess({
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
        world: access.world,
        room: access.room,
        playUri: access.playUri,
      }, detailForRecord(viewer, access, detail))),
      pagination: {
        page,
        limit,
        total: totalRecentActivity,
        totalPages: Math.ceil(totalRecentActivity / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching universe analytics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch universe analytics' },
      { status: 500 }
    );
  }
}

