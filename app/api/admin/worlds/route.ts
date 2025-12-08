import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const createWorldSchema = z.object({
  universeId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  isPublic: z.boolean().default(true),
  featured: z.boolean().default(false),
  thumbnailUrl: z.string().url().nullable().optional(),
});

// GET /api/admin/worlds - List all worlds
export async function GET(request: NextRequest) {
  try {
    // Check if using admin token or session
    const authHeader = request.headers.get('authorization');
    const isAdminToken = authHeader?.startsWith('Bearer ') && 
      authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;
    
    let userId: string | null = null;
    
    if (!isAdminToken) {
      // Try to get user from session
      const { getSessionUser } = await import('@/lib/auth-session');
      const sessionUser = await getSessionUser(request);
      if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      userId = sessionUser.id;
    } else {
      // Admin token - require it
      requireAuth(request);
    }
    
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const search = searchParams.get('search') || '';
    const universeId = searchParams.get('universeId');
    
    const where: any = {};
    
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' as const } },
        { slug: { contains: search, mode: 'insensitive' as const } },
        { description: { contains: search, mode: 'insensitive' as const } },
      ];
    }
    
    // If user session (not admin token), only show worlds in universes they own
    if (userId && !isAdminToken) {
      const userUniverses = await prisma.universe.findMany({
        where: { ownerId: userId },
        select: { id: true },
      });
      const userUniverseIds = userUniverses.map((u: { id: string }) => u.id);
      
      if (userUniverseIds.length === 0) {
        // User owns no universes, return empty result
        return NextResponse.json({
          worlds: [],
          pagination: {
            page,
            limit,
            total: 0,
            totalPages: 0,
          },
        });
      }
      
      // If universeId is specified, verify user owns it
      if (universeId) {
        if (!userUniverseIds.includes(universeId)) {
          return NextResponse.json(
            { error: 'Forbidden' },
            { status: 403 }
          );
        }
        where.universeId = universeId;
      } else {
        // Filter worlds to only those in user's universes
        where.universeId = { in: userUniverseIds };
      }
    } else if (universeId) {
      // Admin token - can filter by any universe
      where.universeId = universeId;
    }
    
    const [worlds, total] = await Promise.all([
      prisma.world.findMany({
        where,
        include: {
          universe: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
          _count: {
            select: {
              rooms: true,
              members: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.world.count({ where }),
    ]);
    
    return NextResponse.json({
      worlds,
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
    console.error('Error fetching worlds:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST /api/admin/worlds - Create a new world
export async function POST(request: NextRequest) {
  try {
    // Check if using admin token or session
    const authHeader = request.headers.get('authorization');
    const isAdminToken = authHeader?.startsWith('Bearer ') && 
      authHeader.replace('Bearer ', '').trim() === process.env.ADMIN_API_TOKEN;
    
    let userId: string | null = null;
    
    if (!isAdminToken) {
      // Try to get user from session
      const { getSessionUser } = await import('@/lib/auth-session');
      const sessionUser = await getSessionUser(request);
      if (!sessionUser) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
      }
      userId = sessionUser.id;
    } else {
      // Admin token - require it
      requireAuth(request);
    }
    
    const body = await request.json();
    
    // Normalize empty strings to null for optional fields
    if (body.thumbnailUrl === '') {
      body.thumbnailUrl = null;
    }
    if (body.description === '') {
      body.description = null;
    }
    
    const data = createWorldSchema.parse(body);
    
    // Verify universe exists and user has permission
    const universe = await prisma.universe.findUnique({
      where: { id: data.universeId },
      select: { id: true, ownerId: true },
    });
    
    if (!universe) {
      return NextResponse.json(
        { error: 'Universe not found' },
        { status: 404 }
      );
    }
    
    // If using session auth (not admin token), ensure user owns the universe
    if (userId && !isAdminToken && universe.ownerId !== userId) {
      return NextResponse.json(
        { error: 'You can only create worlds in universes you own' },
        { status: 403 }
      );
    }
    
    // Check if slug already exists in this universe
    const existing = await prisma.world.findUnique({
      where: {
        universeId_slug: {
          universeId: data.universeId,
          slug: data.slug,
        },
      },
    });
    
    if (existing) {
      return NextResponse.json(
        { error: 'World with this slug already exists in this universe' },
        { status: 409 }
      );
    }
    
    const world = await prisma.world.create({
      data: {
        universeId: data.universeId,
        slug: data.slug,
        name: data.name,
        description: data.description || null,
        isPublic: data.isPublic,
        featured: data.featured,
        thumbnailUrl: data.thumbnailUrl || null,
        // Add the creator as an admin member if userId is available
        ...(userId && {
          members: {
            create: {
              userId: userId,
              tags: ['admin'], // Creator should be an admin
            },
          },
        }),
      },
      include: {
        universe: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        _count: {
          select: {
            rooms: true,
            members: true,
          },
        },
      },
    });
    
    return NextResponse.json(world, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues.map(issue => 
        `${issue.path.join('.')}: ${issue.message}`
      ).join(', ');
      return NextResponse.json(
        { 
          error: 'Validation error', 
          message: errorMessages,
          details: error.issues 
        },
        { status: 400 }
      );
    }
    console.error('Error creating world:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

