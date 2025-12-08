import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const createRoomSchema = z.object({
  worldId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  mapUrl: z.string().url(), // Required - each room must have its own map
  isPublic: z.boolean().default(true),
});

// GET /api/admin/rooms
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
    const worldId = searchParams.get('worldId');
    
    const where: any = {};
    
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' as const } },
        { slug: { contains: search, mode: 'insensitive' as const } },
        { description: { contains: search, mode: 'insensitive' as const } },
      ];
    }
    
    // If user session (not admin token), filter to rooms in worlds they can access
    if (userId && !isAdminToken) {
      // Get worlds where user is admin member or owns the universe
      const userUniverses = await prisma.universe.findMany({
        where: { ownerId: userId },
        select: { id: true },
      });
      const userUniverseIds = userUniverses.map((u: { id: string }) => u.id);
      
      const adminWorlds = await prisma.worldMember.findMany({
        where: {
          userId: userId,
          tags: {
            has: 'admin',
          },
        },
        select: { worldId: true },
      });
      const adminWorldIds = adminWorlds.map((w: { worldId: string }) => w.worldId);
      
      const accessibleWorlds = await prisma.world.findMany({
        where: {
          OR: [
            { universeId: { in: userUniverseIds } },
            { id: { in: adminWorldIds } },
          ],
        },
        select: { id: true },
      });
      const accessibleWorldIds = accessibleWorlds.map((w: { id: string }) => w.id);
      
      if (accessibleWorldIds.length === 0) {
        // User has no accessible worlds, return empty result
        return NextResponse.json({
          rooms: [],
          pagination: {
            page,
            limit,
            total: 0,
            totalPages: 0,
          },
        });
      }
      
      // If worldId is specified, verify user can access it
      if (worldId) {
        if (!accessibleWorldIds.includes(worldId)) {
          return NextResponse.json(
            { error: 'Forbidden' },
            { status: 403 }
          );
        }
        where.worldId = worldId;
      } else {
        // Filter rooms to only those in accessible worlds
        where.worldId = { in: accessibleWorldIds };
      }
    } else if (worldId) {
      // Admin token - can filter by any world
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
    if (body.description === '') {
      body.description = null;
    }
    
    const data = createRoomSchema.parse(body);
    
    // Verify world exists and get universe info
    const world = await prisma.world.findUnique({
      where: { id: data.worldId },
      include: {
        universe: {
          select: {
            id: true,
            ownerId: true,
          },
        },
      },
    });
    
    if (!world) {
      return NextResponse.json(
        { error: 'World not found' },
        { status: 404 }
      );
    }
    
    // If using session auth (not admin token), check permissions
    if (userId && !isAdminToken) {
      // Check if user owns the universe or is an admin member of the world
      const isUniverseOwner = world.universe.ownerId === userId;
      const isWorldAdmin = await prisma.worldMember.findFirst({
        where: {
          worldId: data.worldId,
          userId: userId,
          tags: {
            has: 'admin',
          },
        },
      });
      
      if (!isUniverseOwner && !isWorldAdmin) {
        return NextResponse.json(
          { error: 'You can only create rooms in worlds where you are an admin or own the universe' },
          { status: 403 }
        );
      }
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
        mapUrl: data.mapUrl, // Required field
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

