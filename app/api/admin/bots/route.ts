import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * GET /api/admin/bots
 * List all bots with pagination, filtering, and search (super admin only)
 */
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    
    if (!sessionUser || !isSuperAdmin(sessionUser.email)) {
      return NextResponse.json(
        { error: 'Unauthorized: Super admin access required' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;

    // Filtering
    const roomId = searchParams.get('roomId');
    const worldId = searchParams.get('worldId');
    const universeId = searchParams.get('universeId');
    const enabled = searchParams.get('enabled');
    const aiProviderRef = searchParams.get('aiProviderRef');
    const search = searchParams.get('search');

    // Build where clause
    const where: any = {};

    if (roomId) {
      where.roomId = roomId;
    }

    if (worldId) {
      where.room = {
        worldId: worldId,
      };
    }

    if (universeId) {
      where.room = {
        ...where.room,
        world: {
          universeId: universeId,
        },
      };
    }

    if (enabled !== null && enabled !== undefined) {
      where.enabled = enabled === 'true';
    }

    if (aiProviderRef) {
      where.aiProviderRef = aiProviderRef;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { description: { contains: search, mode: 'insensitive' } },
      ];
    }

    // Fetch bots with relations
    const [bots, total] = await Promise.all([
      prisma.bot.findMany({
        where,
        include: {
          room: {
            include: {
              world: {
                include: {
                  universe: {
                    select: {
                      id: true,
                      slug: true,
                      name: true,
                    },
                  },
                },
              },
            },
          },
          createdBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
        skip,
        take: limit,
      }),
      prisma.bot.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return NextResponse.json({
      bots,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error('Error listing bots:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
