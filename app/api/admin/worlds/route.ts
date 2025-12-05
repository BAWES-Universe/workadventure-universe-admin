import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const createWorldSchema = z.object({
  universeId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  mapUrl: z.string().url().optional().or(z.literal('')),
  wamUrl: z.string().url().optional().or(z.literal('')),
  isPublic: z.boolean().default(true),
  featured: z.boolean().default(false),
  thumbnailUrl: z.string().url().optional().or(z.literal('')),
});

// GET /api/admin/worlds - List all worlds
export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
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
    
    if (universeId) {
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
    requireAuth(request);
    
    const body = await request.json();
    const data = createWorldSchema.parse(body);
    
    // Verify universe exists
    const universe = await prisma.universe.findUnique({
      where: { id: data.universeId },
    });
    
    if (!universe) {
      return NextResponse.json(
        { error: 'Universe not found' },
        { status: 404 }
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
        mapUrl: data.mapUrl || null,
        wamUrl: data.wamUrl || null,
        isPublic: data.isPublic,
        featured: data.featured,
        thumbnailUrl: data.thumbnailUrl || null,
      },
      include: {
        universe: {
          select: {
            id: true,
            name: true,
            slug: true,
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
      return NextResponse.json(
        { error: 'Validation error', details: error.issues },
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

