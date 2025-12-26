import { NextRequest, NextResponse } from 'next/server';
import { requireAuth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { z } from 'zod';

const createRoomSchema = z.object({
  worldId: z.string().uuid(),
  slug: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().nullable().optional(),
  mapUrl: z.string().url().optional(), // Required if templateMapId not provided
  templateMapId: z.string().uuid().optional(), // Optional - if provided, mapUrl will be auto-filled
  isPublic: z.boolean().default(true),
}).refine(
  (data) => data.mapUrl || data.templateMapId,
  {
    message: "Either mapUrl or templateMapId must be provided",
    path: ["mapUrl"],
  }
);

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
    const scope = searchParams.get('scope') || 'my';
    
    const where: any = {};
    
    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' as const } },
        { slug: { contains: search, mode: 'insensitive' as const } },
        { description: { contains: search, mode: 'insensitive' as const } },
      ];
    }
    
    // If user session (not admin token), support scopes
    // - scope=my (default): rooms in worlds they can administer (existing behavior)
    // - scope=discover: public rooms across all worlds
    if (userId && !isAdminToken) {
      if (scope === 'discover') {
        where.isPublic = true;
      } else {
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
      }
    } else if (worldId) {
      // Admin token - can filter by any world
      where.worldId = worldId;
    }
    
    // For discover scope, sort by total accesses (descending)
    // Otherwise, sort by createdAt (descending)
    let rooms: any[];
    let total: number;
    
    if (scope === 'discover' && userId && !isAdminToken) {
      // Build search condition for SQL
      const searchCondition = search
        ? `AND (r.name ILIKE $1 OR r.slug ILIKE $1 OR r.description ILIKE $1)`
        : '';
      const searchParam = search ? `%${search}%` : null;
      
      // Use raw SQL to join with roomAccess, count accesses, and sort by count
      // This ensures proper sorting before pagination
      const query = search
        ? prisma.$queryRaw<Array<{ room_id: string; access_count: bigint }>>`
            SELECT 
              r.id as room_id,
              COALESCE(COUNT(ra.id), 0)::bigint as access_count
            FROM rooms r
            LEFT JOIN room_accesses ra ON r.id = ra.room_id
            WHERE r.is_public = true
            AND (r.name ILIKE ${`%${search}%`} OR r.slug ILIKE ${`%${search}%`} OR r.description ILIKE ${`%${search}%`})
            GROUP BY r.id
            ORDER BY access_count DESC, r.created_at DESC
            LIMIT ${limit} OFFSET ${(page - 1) * limit}
          `
        : prisma.$queryRaw<Array<{ room_id: string; access_count: bigint }>>`
            SELECT 
              r.id as room_id,
              COALESCE(COUNT(ra.id), 0)::bigint as access_count
            FROM rooms r
            LEFT JOIN room_accesses ra ON r.id = ra.room_id
            WHERE r.is_public = true
            GROUP BY r.id
            ORDER BY access_count DESC, r.created_at DESC
            LIMIT ${limit} OFFSET ${(page - 1) * limit}
          `;
      
      const roomIdsWithCounts = await query;
      const roomIds = roomIdsWithCounts.map((r: any) => r.room_id);
      
      // Get total count
      const totalQuery = search
        ? prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(DISTINCT r.id)::bigint as count
            FROM rooms r
            WHERE r.is_public = true
            AND (r.name ILIKE ${`%${search}%`} OR r.slug ILIKE ${`%${search}%`} OR r.description ILIKE ${`%${search}%`})
          `
        : prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(DISTINCT r.id)::bigint as count
            FROM rooms r
            WHERE r.is_public = true
          `;
      const totalResult = await totalQuery;
      total = Number(totalResult[0]?.count || 0);
      
      // Fetch full room data for the sorted IDs
      if (roomIds.length > 0) {
        rooms = await prisma.room.findMany({
          where: {
            ...where,
            id: { in: roomIds },
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
            _count: {
              select: {
                favorites: true,
              },
            },
          },
        });
        
        // Maintain the order from the sorted query
        const roomMap = new Map(rooms.map(r => [r.id, r]));
        rooms = roomIds.map(id => roomMap.get(id)).filter(Boolean) as any[];
      } else {
        rooms = [];
      }
    } else {
      // Default sorting by createdAt
      [rooms, total] = await Promise.all([
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
    }
    
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
    if (body.mapUrl === '') {
      body.mapUrl = undefined;
    }
    
    const data = createRoomSchema.parse(body);
    
    // If templateMapId is provided, fetch the template map and use its mapUrl
    let mapUrl = data.mapUrl;
    let templateMapId = data.templateMapId;
    
    if (templateMapId) {
      const templateMap = await prisma.roomTemplateMap.findUnique({
        where: { id: templateMapId },
      });
      
      if (!templateMap) {
        return NextResponse.json(
          { error: 'Template map not found' },
          { status: 404 }
        );
      }
      
      if (!templateMap.isActive) {
        return NextResponse.json(
          { error: 'Template map is not active' },
          { status: 400 }
        );
      }
      
      // Use template map's URL
      mapUrl = templateMap.mapUrl;
    }
    
    // Ensure we have a mapUrl at this point
    if (!mapUrl) {
      return NextResponse.json(
        { 
          error: 'Validation error', 
          message: 'mapUrl is required if templateMapId is not provided',
        },
        { status: 400 }
      );
    }
    
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
        mapUrl: mapUrl,
        templateMapId: templateMapId || null,
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
    console.error('Error creating room:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

