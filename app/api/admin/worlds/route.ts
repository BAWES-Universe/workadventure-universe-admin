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
    // - scope=my (default): worlds in universes the user owns (existing behavior)
    // - scope=discover: public worlds across all universes
    if (userId && !isAdminToken) {
      if (scope === 'discover') {
        where.isPublic = true;
      } else {
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
      }
    } else if (universeId) {
      // Admin token - can filter by any universe
      where.universeId = universeId;
    }
    
    // For discover scope, sort by total accesses (descending)
    // Otherwise, sort by createdAt (descending)
    let worlds: any[];
    let total: number;
    
    if (scope === 'discover' && userId && !isAdminToken) {
      // Use raw SQL to join with roomAccess via rooms, count accesses, and sort by count
      // This ensures proper sorting before pagination
      const query = search
        ? prisma.$queryRaw<Array<{ world_id: string; access_count: bigint }>>`
            SELECT 
              w.id as world_id,
              COALESCE(COUNT(ra.id), 0)::bigint as access_count
            FROM worlds w
            LEFT JOIN universes u ON w.universe_id = u.id
            LEFT JOIN rooms r ON w.id = r.world_id
            LEFT JOIN room_accesses ra ON r.id = ra.room_id
            WHERE w.is_public = true
            AND NOT (u.slug = 'default' AND w.slug = 'default')
            AND (w.name ILIKE ${`%${search}%`} OR w.slug ILIKE ${`%${search}%`} OR w.description ILIKE ${`%${search}%`})
            GROUP BY w.id
            ORDER BY access_count DESC, w.created_at DESC
            LIMIT ${limit} OFFSET ${(page - 1) * limit}
          `
        : prisma.$queryRaw<Array<{ world_id: string; access_count: bigint }>>`
            SELECT 
              w.id as world_id,
              COALESCE(COUNT(ra.id), 0)::bigint as access_count
            FROM worlds w
            LEFT JOIN universes u ON w.universe_id = u.id
            LEFT JOIN rooms r ON w.id = r.world_id
            LEFT JOIN room_accesses ra ON r.id = ra.room_id
            WHERE w.is_public = true
            AND NOT (u.slug = 'default' AND w.slug = 'default')
            GROUP BY w.id
            ORDER BY access_count DESC, w.created_at DESC
            LIMIT ${limit} OFFSET ${(page - 1) * limit}
          `;
      
      const worldIdsWithCounts = await query;
      const worldIds = worldIdsWithCounts.map((w: any) => w.world_id);
      
      // Get total count
      const totalQuery = search
        ? prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(DISTINCT w.id)::bigint as count
            FROM worlds w
            LEFT JOIN universes u ON w.universe_id = u.id
            WHERE w.is_public = true
            AND NOT (u.slug = 'default' AND w.slug = 'default')
            AND (w.name ILIKE ${`%${search}%`} OR w.slug ILIKE ${`%${search}%`} OR w.description ILIKE ${`%${search}%`})
          `
        : prisma.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(DISTINCT w.id)::bigint as count
            FROM worlds w
            LEFT JOIN universes u ON w.universe_id = u.id
            WHERE w.is_public = true
            AND NOT (u.slug = 'default' AND w.slug = 'default')
          `;
      const totalResult = await totalQuery;
      total = Number(totalResult[0]?.count || 0);
      
      // Fetch full world data for the sorted IDs
      if (worldIds.length > 0) {
        worlds = await prisma.world.findMany({
          where: {
            ...where,
            id: { in: worldIds },
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
        
        // Maintain the order from the sorted query
        const worldMap = new Map(worlds.map(w => [w.id, w]));
        worlds = worldIds.map(id => worldMap.get(id)).filter(Boolean) as any[];
      } else {
        worlds = [];
      }
    } else {
      // Default sorting by createdAt
      [worlds, total] = await Promise.all([
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
    }
    
    // Calculate aggregated favorites counts for all worlds
    // Count favorites directly by worldId (much more efficient)
    const worldIds = worlds.map((w: any) => w.id);
    const favoritesByWorld = worldIds.length > 0
      ? await prisma.favorite.groupBy({
          by: ['worldId'],
          where: {
            worldId: { in: worldIds },
          },
          _count: {
            id: true,
          },
        })
      : [];
    
    const favoritesCountMap = new Map(
      favoritesByWorld.map((fb) => [fb.worldId!, fb._count.id])
    );

    // Add favorites count to each world
    const worldsWithFavorites = worlds.map((world: any) => ({
      ...world,
      _count: {
        ...world._count,
        favorites: favoritesCountMap.get(world.id) || 0,
      },
    }));
    
    return NextResponse.json({
      worlds: worldsWithFavorites,
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

