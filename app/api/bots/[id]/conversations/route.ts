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
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    requireServiceToken(request);

    const { id: botId } = await params;
    const body = await request.json();

    const {
      userUuid,      // WorkAdventure UUID (string) - REQUIRED
      userId,        // User.id if authenticated (string) - Optional, will be matched if not provided
      userName,      // Display name (string)
      isGuest,       // boolean - if false, try to match UUID
      isLogged,      // Alternative field from bot server (true if authenticated)
      messages,
      startedAt,
      endedAt,
      messageCount,
    } = body;

    // Validate required fields
    if (!userUuid || !messages || !Array.isArray(messages) || !startedAt || !endedAt) {
      return NextResponse.json(
        { error: 'Missing required fields: userUuid, messages, startedAt, endedAt' },
        { status: 400, headers: corsHeaders() }
      );
    }

    // Determine if user is logged in (check both isGuest and isLogged)
    const userIsLogged = isGuest === false || isLogged === true;

    // Fire-and-forget: Don't await, just start the operation
    // This includes UUID matching, so it won't block the bot server response
    (async () => {
      try {
        // Try to match userUuid to User table if user is logged in
        let finalUserId: string | null = userId || null;
        let finalIsGuest = true;

        if (userIsLogged) {
          // Try to find user by UUID (even if userId was provided, verify it matches)
          try {
            const user = await prisma.user.findUnique({
              where: { uuid: userUuid },
              select: { id: true },
            });

            if (user) {
              finalUserId = user.id;
              finalIsGuest = false;
            } else if (finalUserId) {
              // userId was provided but UUID doesn't match - use provided userId but log warning
              console.warn(`User UUID ${userUuid} not found, but userId ${finalUserId} was provided`);
              finalIsGuest = false;
            } else {
              // User claims to be logged in but UUID not found - treat as guest
              console.warn(`User UUID ${userUuid} not found in database, treating as guest despite isGuest=false`);
              finalIsGuest = true;
            }
          } catch (err) {
            // Database error during lookup - log but continue with provided userId if available
            console.error(`Error looking up user with uuid ${userUuid}:`, err);
            if (finalUserId) {
              finalIsGuest = false;
            }
          }
        } else if (finalUserId) {
          // If userId was provided but user is marked as guest, trust the userId
          finalIsGuest = false;
        }

        // Store conversation with matched userId
        await prisma.botsConversation.create({
          data: {
            botId,
            userUuid,
            userId: finalUserId,
            userName: userName || null,
            isGuest: finalIsGuest,
            messages: messages,
            startedAt: new Date(startedAt),
            endedAt: new Date(endedAt),
            messageCount: messageCount || messages.length,
          },
        });
      } catch (err) {
        // Log error but don't block response (fire-and-forget)
        console.error('Error storing conversation:', err);
      }
    })();

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
 * - userUuid: Filter by user UUID (string)
 * - userId: Filter by user ID (string)
 * - startDate: Start timestamp
 * - endDate: End timestamp
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdminAuth(request);

    const { id: botId } = await params;
    const { searchParams } = new URL(request.url);

    // Parse query params
    const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 500);
    const offset = parseInt(searchParams.get('offset') || '0', 10);
    const userUuid = searchParams.get('userUuid');
    const userId = searchParams.get('userId');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    // Build where clause
    const where: any = {
      botId,
    };

    if (userUuid) {
      where.userUuid = userUuid;
    }
    if (userId) {
      where.userId = userId;
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

    // Query conversations with user relation
    const [conversations, totalCount] = await Promise.all([
      prisma.botsConversation.findMany({
        where,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              name: true,
              uuid: true,
            },
          },
        },
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
