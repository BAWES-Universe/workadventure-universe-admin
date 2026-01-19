import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * GET /api/admin/bots/conversations
 * Browse all conversations with pagination and filters (super admin only)
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
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));
    const skip = (page - 1) * limit;

    // Filters
    const botId = searchParams.get('botId');
    const playerId = searchParams.get('playerId');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    // Build where clause
    const where: any = {};

    if (botId) {
      where.botId = botId;
    }

    if (playerId) {
      where.playerId = parseInt(playerId, 10);
    }

    if (startDate || endDate) {
      where.endedAt = {};
      if (startDate) {
        where.endedAt.gte = new Date(startDate);
      }
      if (endDate) {
        where.endedAt.lte = new Date(endDate);
      }
    }

    // Fetch conversations with pagination
    const [conversations, total] = await Promise.all([
      prisma.botsConversation.findMany({
        where,
        orderBy: { endedAt: 'desc' },
        skip,
        take: limit,
      }),
      prisma.botsConversation.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return NextResponse.json({
      conversations,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error('Error listing conversations:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
