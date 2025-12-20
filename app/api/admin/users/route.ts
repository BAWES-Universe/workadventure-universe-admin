import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';

// GET /api/admin/users - List all users
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
      // Session users can also view users list
    } else {
      // Admin token - require it
      requireAuth(request);
    }
    
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const search = searchParams.get('search') || '';
    
    const where = search
      ? {
          OR: [
            { name: { contains: search, mode: 'insensitive' as const } },
            { email: { contains: search, mode: 'insensitive' as const } },
            { uuid: { contains: search, mode: 'insensitive' as const } },
          ],
        }
      : {};
    
    // First get all users matching the search
    const allUsers = await prisma.user.findMany({
      where,
      select: {
        id: true,
        uuid: true,
        email: true,
        name: true,
        isGuest: true,
        createdAt: true,
        _count: {
          select: {
            ownedUniverses: true,
            worldMemberships: true,
          },
        },
      },
    });
    
    if (allUsers.length === 0) {
      return NextResponse.json({
        users: [],
        pagination: {
          page,
          limit,
          total: 0,
          totalPages: 0,
        },
      });
    }
    
    const userIds = allUsers.map(u => u.id);
    const userUuids = allUsers.map(u => u.uuid).filter(Boolean);
    
    // Get access counts for all users at once using groupBy
    const accessCountsByUserId = await prisma.roomAccess.groupBy({
      by: ['userId'],
      where: {
        userId: { in: userIds },
      },
      _count: { userId: true },
    });
    
    const accessCountsByUserUuid = await prisma.roomAccess.groupBy({
      by: ['userUuid'],
      where: {
        userUuid: { in: userUuids },
        userId: null, // Only count UUID accesses where userId is null to avoid double counting
      },
      _count: { userUuid: true },
    });
    
    // Create maps for quick lookup
    const countByUserId = new Map(accessCountsByUserId.map(a => [a.userId, a._count.userId]));
    const countByUserUuid = new Map(accessCountsByUserUuid.map(a => [a.userUuid, a._count.userUuid]));
    
    // Get all accesses for these users to find last accessed dates
    const allAccesses = await prisma.roomAccess.findMany({
      where: {
        OR: [
          { userId: { in: userIds } },
          { userUuid: { in: userUuids } },
        ],
      },
      select: {
        userId: true,
        userUuid: true,
        accessedAt: true,
      },
      orderBy: { accessedAt: 'desc' },
    });
    
    // Create map for last access lookup - find most recent access for each user
    const lastAccessMap = new Map<string, Date>();
    allUsers.forEach(user => {
      let mostRecent: Date | null = null;
      allAccesses.forEach(access => {
        if ((access.userId === user.id || access.userUuid === user.uuid) && access.accessedAt) {
          if (!mostRecent || access.accessedAt > mostRecent) {
            mostRecent = access.accessedAt;
          }
        }
      });
      if (mostRecent) {
        lastAccessMap.set(user.id, mostRecent);
      }
    });
    
    // Combine access counts (userId + userUuid - they don't overlap since each access has either userId OR userUuid)
    const usersWithAccess = allUsers.map((user) => {
      const countById = countByUserId.get(user.id) || 0;
      const countByUuid = user.uuid ? (countByUserUuid.get(user.uuid) || 0) : 0;
      // Sum them since accesses with userId and userUuid are separate (no overlap)
      const totalAccesses = countById + countByUuid;
      const lastAccessed = lastAccessMap.get(user.id) || null;
      
      return {
        ...user,
        totalAccesses,
        lastAccessed: lastAccessed ? lastAccessed.toISOString() : null,
      };
    });
    
    // Sort by last accessed (most recent first), then by total accesses, then by createdAt
    usersWithAccess.sort((a, b) => {
      // Users with access come first
      if (a.lastAccessed && !b.lastAccessed) return -1;
      if (!a.lastAccessed && b.lastAccessed) return 1;
      
      // If both have lastAccessed, sort by most recent
      if (a.lastAccessed && b.lastAccessed) {
        const dateA = new Date(a.lastAccessed).getTime();
        const dateB = new Date(b.lastAccessed).getTime();
        const dateDiff = dateB - dateA;
        if (dateDiff !== 0) return dateDiff;
      }
      
      // If same lastAccessed or both null, sort by total accesses
      const accessDiff = b.totalAccesses - a.totalAccesses;
      if (accessDiff !== 0) return accessDiff;
      
      // Finally sort by createdAt
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });
    
    // Apply pagination
    const total = usersWithAccess.length;
    const paginatedUsers = usersWithAccess.slice((page - 1) * limit, page * limit);
    
    return NextResponse.json({
      users: paginatedUsers,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    console.error('Error fetching users:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

