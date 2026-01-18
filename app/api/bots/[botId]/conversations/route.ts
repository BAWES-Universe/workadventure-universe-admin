import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/:botId/conversations
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * POST /api/bots/:botId/conversations
 * Store conversation when it ends
 * 
 * Auth: BOT_SERVICE_TOKEN
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    requireServiceToken(request);

    const { botId } = await params;
    const body = await request.json();

    const {
      playerId,
      playerName,
      messages,
      startedAt,
      endedAt,
      messageCount,
    } = body;

    // Validate required fields
    if (!playerId || !messages || !Array.isArray(messages) || !startedAt || !endedAt) {
      return NextResponse.json(
        { error: 'Missing required fields: playerId, messages, startedAt, endedAt' },
        { status: 400, headers: corsHeaders() }
      );
    }

    // Fire-and-forget: Don't await, just start the operation
    prisma.botsConversation
      .create({
        data: {
          botId,
          playerId: Number(playerId),
          playerName: playerName || null,
          messages: messages,
          startedAt: new Date(startedAt),
          endedAt: new Date(endedAt),
          messageCount: messageCount || messages.length,
        },
      })
      .catch((err) => {
        // Log error but don't block response
        console.error('Error storing conversation:', err);
      });

    // Return immediately (fire-and-forget)
    return NextResponse.json(
      { status: 'stored' },
      { headers: corsHeaders() }
    );
  } catch (error: any) {
    if (error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    // For other errors, still return success (fire-and-forget)
    console.error('Error in conversation storage endpoint:', error);
    return NextResponse.json(
      { status: 'stored' }, // Return success even on error (fire-and-forget)
      { headers: corsHeaders() }
    );
  }
}

/**
 * GET /api/bots/:botId/conversations
 * Get conversations with filters
 * 
 * Auth: Admin (session or admin token)
 * 
 * Query params:
 * - limit: Maximum results (default: 50)
 * - offset: Pagination offset
 * - playerId: Filter by player ID
 * - startDate: Start timestamp
 * - endDate: End timestamp
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    await requireAdminAuth(request);

    const { botId } = await params;
    const { searchParams } = new URL(request.url);

    // Parse query params
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 500);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const playerId = searchParams.get('playerId');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    // Build where clause
    const where: any = {
      botId,
    };

    if (playerId) {
      where.playerId = parseInt(playerId, 10);
    }

    if (startDate || endDate) {
      where.endedAt = {};
      if (startDate) {
        where.endedAt.gte = new Date(parseInt(startDate, 10));
      }
      if (endDate) {
        where.endedAt.lte = new Date(parseInt(endDate, 10));
      }
    }

    // Query conversations
    const [conversations, totalCount] = await Promise.all([
      prisma.botsConversation.findMany({
        where,
        orderBy: { endedAt: 'desc' },
        take: limit,
        skip: offset,
      }),
      prisma.botsConversation.count({ where }),
    ]);

    return NextResponse.json(
      {
        botId,
        conversations,
        count: totalCount,
      },
      { headers: corsHeaders() }
    );
  } catch (error: any) {
    if (error.message === 'Unauthorized: Admin authentication required') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error querying conversations:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
