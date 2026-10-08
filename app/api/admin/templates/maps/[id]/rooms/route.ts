import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { andNotSystemOwnedSql, hiddenSystemOwnerId, notSystemRoom } from '@/lib/system-user';

// GET /api/admin/templates/maps/[id]/rooms
// Get all rooms using this template map (public endpoint)
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '12');
    const sortBy = searchParams.get('sortBy') || 'created';
    const skip = (page - 1) * limit;

    // Verify map exists
    const map = await prisma.roomTemplateMap.findUnique({
      where: { id },
      select: { id: true, isActive: true },
    });

    if (!map) {
      return NextResponse.json(
        { error: 'Map not found' },
        { status: 404 }
      );
    }

    // Never System's rooms once they are hidden (the start room is elsewhere)
    const hidden = await hiddenSystemOwnerId();
    const notSystem = hidden
      ? Prisma.sql`AND EXISTS (SELECT 1 FROM worlds w JOIN universes u ON u.id = w.universe_id WHERE w.id = r.world_id ${andNotSystemOwnedSql(hidden)})`
      : Prisma.empty;

    // Get total count
    const total = await prisma.room.count({
      where: {
        templateMapId: id,
        isPublic: true,
        ...notSystemRoom(hidden),
      },
    });

    let rooms: any[];
    let roomIds: string[] = [];

    // Handle sorting by access count or favorites using raw SQL
    if (sortBy === 'accesses') {
      const result = await prisma.$queryRaw<Array<{ room_id: string; access_count: bigint }>>`
        SELECT 
          r.id as room_id,
          COALESCE(COUNT(ra.id), 0)::bigint as access_count
        FROM rooms r
        LEFT JOIN room_accesses ra ON r.id = ra.room_id
        WHERE r.template_map_id = ${id}
        AND r.is_public = true
        ${notSystem}
        GROUP BY r.id
        ORDER BY access_count DESC, r.created_at DESC
        LIMIT ${limit} OFFSET ${skip}
      `;
      roomIds = result.map((r: any) => r.room_id);
    } else if (sortBy === 'stars') {
      const result = await prisma.$queryRaw<Array<{ room_id: string; favorite_count: bigint }>>`
        SELECT 
          r.id as room_id,
          COALESCE(COUNT(f.id), 0)::bigint as favorite_count
        FROM rooms r
        LEFT JOIN favorites f ON r.id = f.room_id
        WHERE r.template_map_id = ${id}
        AND r.is_public = true
        ${notSystem}
        GROUP BY r.id
        ORDER BY favorite_count DESC, r.created_at DESC
        LIMIT ${limit} OFFSET ${skip}
      `;
      roomIds = result.map((r: any) => r.room_id);
    }

    // Fetch full room data
    if (sortBy === 'accesses' || sortBy === 'stars') {
      // For access/stars sorting, fetch rooms in the order from the sorted query
      if (roomIds.length > 0) {
        rooms = await prisma.room.findMany({
          where: {
            id: { in: roomIds },
            templateMapId: id,
            isPublic: true,
            ...notSystemRoom(hidden),
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
      // Default: sort by createdAt
      rooms = await prisma.room.findMany({
        where: {
          templateMapId: id,
          isPublic: true,
          ...notSystemRoom(hidden),
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
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      });
    }

    const totalPages = Math.ceil(total / limit);

    return NextResponse.json({
      rooms,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error('Error fetching rooms for map:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

