import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { UNIVERSE_AI_REF, resolveUniverseAiProvider } from '@/lib/universe-ai';
import { readUsagePriceFacts } from '@/lib/ai-usage-cost';

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
      userId: talkedUserId = null,
      providerId: sentProviderId,
      tokensUsed = 0,
      apiCalls = 1,
      durationSeconds = null,
      cost = null,
      latency = null,
      error = false,
      timestamp = new Date(),
    } = body;

    // A bot on Universe AI is paid for by the provider that is the Default, so that is the row the usage belongs to
    let providerId = sentProviderId;
    if (providerId === UNIVERSE_AI_REF) {
      providerId = (await resolveUniverseAiProvider())?.providerId;
    }

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

    // What the reply cost and how that was worked out (game #1173). A bot server from before it sends only `cost`, and
    // that row stays an old estimate: its `cost` is kept and no price facts are filled in.
    const facts = readUsagePriceFacts(body);

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
          // A row with price facts leaves the old column empty, so an old estimate and a real price are never both on one row
          cost: facts ? null : cost !== null ? cost : null,
          ...(facts ?? {}),
          latency,
          error,
          timestamp: timestamp ? new Date(timestamp) : new Date(),
          // Who talked (as the bot server knows them) and whose key paid; the key's owner comes from the provider row, never from the request
          talkedUserId: typeof talkedUserId === 'string' && talkedUserId ? talkedUserId.slice(0, 255) : null,
          keyOwnerId: provider.ownerId ?? null,
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

