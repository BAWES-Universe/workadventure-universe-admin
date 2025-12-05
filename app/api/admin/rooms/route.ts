import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const createRoomSchema = z.object({
  worldId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  mapUrl: z.string().url().optional().or(z.literal('')),
  isPublic: z.boolean().default(true),
});

// GET /api/admin/rooms
export async function GET(request: NextRequest) {
  try {
    requireAuth(request);
    
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '50');
    const search = searchParams.get('search') || '';
    const worldId = searchParams.get('worldId');
    
    const where: any = {};
    
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' as const } },
        { slug: { contains: search, mode: 'insensitive' as const } },
        { description: { contains: search, mode: 'insensitive' as const } },
      ];
    }
    
    if (worldId) {
      where.worldId = worldId;
    }
    
    const [rooms, total] = await Promise.all([
      prisma.room.findMany({
        where,
        include: {
          world: {
            include: {
              universe: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                },
              },
            },
          },
          _count: {
            select: {
              favorites: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.room.count({ where }),
    ]);
    
    return NextResponse.json({
      rooms,
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
    console.error('Error fetching rooms:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

// POST /api/admin/rooms
export async function POST(request: NextRequest) {
  try {
    requireAuth(request);
    
    const body = await request.json();
    const data = createRoomSchema.parse(body);
    
    // Verify world exists
    const world = await prisma.world.findUnique({
      where: { id: data.worldId },
    });
    
    if (!world) {
      return NextResponse.json(
        { error: 'World not found' },
        { status: 404 }
      );
    }
    
    // Check if slug already exists in this world
    const existing = await prisma.room.findUnique({
      where: {
        worldId_slug: {
          worldId: data.worldId,
          slug: data.slug,
        },
      },
    });
    
    if (existing) {
      return NextResponse.json(
        { error: 'Room with this slug already exists in this world' },
        { status: 409 }
      );
    }
    
    const room = await prisma.room.create({
      data: {
        worldId: data.worldId,
        slug: data.slug,
        name: data.name,
        description: data.description || null,
        mapUrl: data.mapUrl || null,
        isPublic: data.isPublic,
      },
      include: {
        world: {
          include: {
            universe: {
              select: {
                id: true,
                name: true,
                slug: true,
              },
            },
          },
        },
      },
    });
    
    return NextResponse.json(room, { status: 201 });
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
    console.error('Error creating room:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

