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
    
    return NextResponse.json(user);
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

