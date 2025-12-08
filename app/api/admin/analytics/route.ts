import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const universeId = searchParams.get('universeId');
    const worldId = searchParams.get('worldId');
    const roomId = searchParams.get('roomId');
    const userId = searchParams.get('userId');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    
    // Build where clause
    const where: any = {};
    
    if (universeId) where.universeId = universeId;
    if (worldId) where.worldId = worldId;
    if (roomId) where.roomId = roomId;
    if (userId) where.userId = userId;
    
    if (startDate || endDate) {
      where.accessedAt = {};
      if (startDate) where.accessedAt.gte = new Date(startDate);
      if (endDate) where.accessedAt.lte = new Date(endDate);
    }
    
    // Get total accesses
    const totalAccesses = await prisma.roomAccess.count({ where });
    
    // Get unique users (count distinct userId where not null + count distinct userUuid)
    const uniqueUserIds = await prisma.roomAccess.findMany({
      where: {
        ...where,
        userId: { not: null },
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    
    const uniqueUserUuids = await prisma.roomAccess.findMany({
      where: {
        ...where,
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
      where,
      select: { ipAddress: true },
      distinct: ['ipAddress'],
    });
    
    // Get time series data (group by day) - simplified approach
    const allAccesses = await prisma.roomAccess.findMany({
      where,
      select: { accessedAt: true },
      orderBy: { accessedAt: 'desc' },
      take: 1000, // Limit for performance
    });
    
    // Group by day
    const timeSeriesMap = new Map<string, number>();
    allAccesses.forEach(access => {
      const date = access.accessedAt.toISOString().split('T')[0];
      timeSeriesMap.set(date, (timeSeriesMap.get(date) || 0) + 1);
    });
    
    const timeSeries = Array.from(timeSeriesMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(-30); // Last 30 days
    
    return NextResponse.json({
      totalAccesses,
      uniqueUsers,
      uniqueIPs: uniqueIps.length,
      timeSeries,
    });
  } catch (error) {
    console.error('Error fetching analytics:', error);
    return NextResponse.json(
      { error: 'Failed to fetch analytics' },
      { status: 500 }
    );
  }
}

