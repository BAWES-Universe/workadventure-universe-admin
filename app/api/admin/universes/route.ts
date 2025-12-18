import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const createUniverseSchema = z.object({
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  ownerId: z.string().uuid(),
  isPublic: z.boolean().default(true),
  featured: z.boolean().default(false),
  thumbnailUrl: z.string().url().nullable().optional(),
});

const updateUniverseSchema = createUniverseSchema.partial();

// GET /api/admin/universes - List universes
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
    const ownerId = searchParams.get('ownerId');
    const scope = searchParams.get('scope') || 'my';
    
    const where: any = {};
    
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' as const } },
        { slug: { contains: search, mode: 'insensitive' as const } },
        { description: { contains: search, mode: 'insensitive' as const } },
      ];
    }
    
    if (isAdminToken) {
      // Admin token callers keep existing behavior:
      // - When ownerId is provided, filter by it
      // - Otherwise, return all universes (subject to search filters)
      if (ownerId) {
        where.ownerId = ownerId;
      }
    } else if (userId) {
      // Session-based callers: support scopes
      // - scope=my (default): universes owned by the current user
      // - scope=discover: public universes (including your own), excluding the default universe
      if (scope === 'discover') {
        where.isPublic = true;
        // Hide the built-in default universe (default/default/default)
        where.slug = { not: 'default' };
      } else {
        // Fallback to \"my\" semantics for unknown scope values
        where.ownerId = userId;
      }
    }
    
    const [universes, total] = await Promise.all([
      prisma.universe.findMany({
        where,
        include: {
          owner: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          _count: {
            select: {
              worlds: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.universe.count({ where }),
    ]);
    
    return NextResponse.json({
      universes,
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
    console.error('Error fetching universes:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST /api/admin/universes - Create a new universe
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
    
    // Debug logging
    console.log('Creating universe with data:', JSON.stringify(body, null, 2));
    
    const data = createUniverseSchema.parse(body);
    
    // If using session auth (not admin token), ensure user can only create universes for themselves
    if (userId && !isAdminToken && data.ownerId !== userId) {
      return NextResponse.json(
        { error: 'You can only create universes for yourself' },
        { status: 403 }
      );
    }
    
    // Check if slug already exists
    const existing = await prisma.universe.findUnique({
      where: { slug: data.slug },
    });
    
    if (existing) {
      return NextResponse.json(
        { error: 'Universe with this slug already exists' },
        { status: 409 }
      );
    }
    
    // Verify owner exists
    const owner = await prisma.user.findUnique({
      where: { id: data.ownerId },
    });
    
    if (!owner) {
      return NextResponse.json(
        { error: 'Owner user not found' },
        { status: 404 }
      );
    }
    
    const universe = await prisma.universe.create({
      data: {
        slug: data.slug,
        name: data.name,
        description: data.description || null,
        ownerId: data.ownerId,
        isPublic: data.isPublic,
        featured: data.featured,
        thumbnailUrl: data.thumbnailUrl || null,
      },
      include: {
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });
    
    return NextResponse.json(universe, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof z.ZodError) {
      console.error('Validation error:', error.issues);
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
    console.error('Error creating universe:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

