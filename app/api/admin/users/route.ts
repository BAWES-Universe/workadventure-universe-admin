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
    
    const [users, total] = await Promise.all([
      prisma.user.findMany({
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
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.user.count({ where }),
    ]);
    
    return NextResponse.json({
      users,
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

