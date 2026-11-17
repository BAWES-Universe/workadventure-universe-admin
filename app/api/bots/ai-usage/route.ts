import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { UNIVERSE_AI_REF, resolveUniverseAiProvider } from '@/lib/universe-ai';
import { readUsagePriceFacts } from '@/lib/ai-usage-cost';
import { readUsageChannel, resolveUsagePerson } from '@/lib/usage-person';
import { recordModelCall } from '@/lib/meter';
import { runOfBrick } from '@/lib/brick-items';

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
      isGuest = null,
      channel = null,
      providerId: sentProviderId,
      tokensUsed = 0,
      apiCalls = 1,
      durationSeconds = null,
      cost = null,
      latency = null,
      error = false,
      timestamp = new Date(),
      greeting = false,
      eventId: clientEventId = null,
      runId: sentRunId = null,
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

    // Who talked, matched to their Orbit account so the bot page can name them (#491); a guest is only counted
    const talked = typeof talkedUserId === 'string' && talkedUserId ? talkedUserId.slice(0, 255) : null;
    const named = await resolveUsagePerson(talked, isGuest);
    const task = readUsageChannel(channel) === 'task';

    // Fire-and-forget: Don't await, just start the operation
    // This ensures bot operation isn't blocked if tracking fails
    (async () => {
      // A model call a goal or task made is the usage of the Brick's owner whoever the bot server names (it may name nobody), so it is
      // always counted in their window and against the share goals and tasks may use. Looked up here, with the write, so a failed lookup is
      // handled like any other failure of this report and never stops it: the row is still written, as the bot server named the person
      let person = named;
      if (task) {
        try {
          const brick = await prisma.bot.findUnique({ where: { id: botId }, select: { ownerId: true } });
          if (brick?.ownerId) person = { personId: brick.ownerId, guest: false };
        } catch (err) {
          console.error('Error looking up whose Brick made a task call:', err);
        }
      }
      return prisma.botsAiUsage.create({
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
          talkedUserId: talked,
          keyOwnerId: provider.ownerId ?? null,
          // Direct messages or nearby chat, and the person as Orbit knows them (#491, #1159 step 6)
          channel: readUsageChannel(channel),
          talkedPersonId: person.personId,
          talkedGuest: person.guest,
          // A greeting the bot made on its own: still the payer's usage, never counted against the person it greeted
          greeting: greeting === true,
          // The run of a goal or task the call was made for (game #2002), kept only as the bot server's word for it
          brickRunId: typeof sentRunId === 'string' && sentRunId ? sentRunId.slice(0, 36) : null,
        },
      });
    })()
      // The meter's books (game #1998) copy the call from the row that was just counted. They never hold up or fail the report
      .then(async (row) =>
        recordModelCall({
          usageRowId: row.id,
          botId,
          // The bot server's own id for the call, when it sends one, so a report it sends twice is one event in the books
          clientEventId: typeof clientEventId === 'string' && clientEventId ? clientEventId.slice(0, 200) : null,
          providerId,
          sentProviderId,
          keyOwnerId: row.keyOwnerId,
          talkedUserId: row.talkedUserId,
          talkedPersonId: row.talkedPersonId,
          talkedGuest: row.talkedGuest,
          channel: row.channel,
          tokensUsed: row.tokensUsed,
          apiCalls: row.apiCalls,
          error: row.error,
          greeting: row.greeting,
          costBasis: row.costBasis,
          costMicros: row.costMicros,
          tokens: { input: row.inputTokens, cached: row.cachedTokens, cacheWrite: row.cacheWriteTokens, output: row.outputTokens, reasoning: row.reasoningTokens },
          occurredAt: row.timestamp,
          // The run the call was made for, in the books only when it is one of this Brick's own (the bot server's word is checked, never trusted)
          runKey: row.brickRunId,
          runId: await runOfBrick(botId, row.brickRunId),
        }),
      )
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

