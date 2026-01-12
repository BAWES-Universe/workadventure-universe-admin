import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';

/**
 * POST /api/bots/ai-usage
 * Track AI usage (tokens, API calls, costs)
 * 
 * Auth: Service token only
 * Fire-and-forget (non-blocking)
 */
export async function POST(request: NextRequest) {
  try {
    // Require service token
    requireServiceToken(request);

    const body = await request.json();
    const {
      botId,
      providerId,
      tokensUsed = 0,
      apiCalls = 1,
      durationSeconds = null,
      cost = null,
      latency = null,
      error = false,
      timestamp = new Date(),
    } = body;

    // Validate required fields
    if (!botId || !providerId) {
      return NextResponse.json(
        { error: 'botId and providerId are required' },
        { status: 400 }
      );
    }

    // Verify provider exists
    const provider = await prisma.botsAiProvider.findUnique({
      where: { providerId },
    });

    if (!provider) {
      return NextResponse.json(
        { error: 'Provider not found' },
        { status: 404 }
      );
    }

    // Fire-and-forget: Don't await, just start the operation
    // This ensures bot operation isn't blocked if tracking fails
    prisma.botsAiUsage
      .create({
        data: {
          botId,
          providerId,
          tokensUsed,
          apiCalls,
          durationSeconds,
          cost: cost !== null ? cost : null,
          latency,
          error,
          timestamp: timestamp ? new Date(timestamp) : new Date(),
        },
      })
      .catch((err) => {
        // Log error but don't block response
        console.error('Error tracking AI usage:', err);
      });

    // Return immediately (fire-and-forget)
    return NextResponse.json({
      status: 'tracked',
    });
  } catch (error: any) {
    if (error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // For other errors, still return success (fire-and-forget)
    // Log the error but don't fail the request
    console.error('Error in usage tracking endpoint:', error);
    return NextResponse.json({
      status: 'tracked', // Return success even on error (fire-and-forget)
    });
  }
}

