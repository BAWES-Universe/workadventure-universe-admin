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
    
    // Get total accesses for this room
    const totalAccesses = await prisma.roomAccess.count({
      where: { roomId: id },
    });
    
    // Get unique users
    const uniqueUserIds = await prisma.roomAccess.findMany({
      where: {
        roomId: id,
        userId: { not: null },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    
    const uniqueUserUuids = await prisma.roomAccess.findMany({
      where: {
        roomId: id,
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
      where: { roomId: id },
      select: { ipAddress: true },
      distinct: ['ipAddress'],
    });
    
    // Get peak times (group by hour in UTC)
    // Note: Frontend calculates peak hours in user's local timezone from recent activity
    // This is kept for backwards compatibility/fallback
    const allAccesses = await prisma.roomAccess.findMany({
      where: { roomId: id },
      select: { accessedAt: true },
    });
    
    const hourCounts = new Map<number, number>();
    allAccesses.forEach(access => {
      // Calculate in UTC (frontend will use local timezone from recent activity)
      const hour = access.accessedAt.getUTCHours();
      hourCounts.set(hour, (hourCounts.get(hour) || 0) + 1);
    });
    
    const peakTimes = Array.from(hourCounts.entries())
      .map(([hour, count]) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
    
    // Get recent activity (last 20 accesses)
    const recentActivity = await prisma.roomAccess.findMany({
      where: { roomId: id },
      orderBy: { accessedAt: 'desc' },
      take: 20,
    });
    
    return NextResponse.json({
      totalAccesses,
      uniqueUsers,
      uniqueIPs: uniqueIps.length,
      peakTimes,
      recentActivity: recentActivity.map(access => ({
        id: access.id,
        accessedAt: access.accessedAt,
        userName: access.userName,
        userEmail: access.userEmail,
        userUuid: access.userUuid,
        ipAddress: access.ipAddress,
        isGuest: access.isGuest,
        isAuthenticated: access.isAuthenticated,
        hasMembership: access.hasMembership,
        membershipTags: access.membershipTags,
        playUri: access.playUri,
      })),
    });
  } catch (error) {
    console.error('Error fetching room analytics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch room analytics' },
      { status: 500 }
    );
  }
}

