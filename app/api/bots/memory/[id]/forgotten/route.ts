import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';
import { acknowledgeForgets } from '@/lib/bot-privacy';

export const runtime = 'nodejs';

/** More than a bot is ever asked to forget at once; the bot server sends what it was told, in one go. */
const MAX_IDS = 500;

const bodySchema = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(MAX_IDS) }).strict();

export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * POST /api/bots/memory/:botId/forgotten
 * Hide bot conversations (#435, #493): the bot server reports the Forgets it has dropped from what it holds in memory.
 * Body: { ids: string[] }, the row ids it was sent in the `forget` part of a privacy answer or a memory save.
 *
 * Orbit keeps a Forget, and keeps skipping that person in memory saves, until this report, however long Orbit was out
 * of reach in between. Only then is the row removed. Ids that are gone already, or belong to another bot, are ignored.
 *
 * Auth: BOT_SERVICE_TOKEN only. The deployment admin token cannot report one.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);

    const { id: botId } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return NextResponse.json({ error: 'Invalid request data', details: parsed.error.issues }, { status: 400, headers: corsHeaders() });
    }

    const acknowledged = await acknowledgeForgets(botId, parsed.data.ids);
    return NextResponse.json({ acknowledged }, { headers: corsHeaders() });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders() });
    }
    Sentry.captureException(error, { tags: { area: 'bot-privacy' } });
    console.error('Error saving that a Forget was dropped:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders() });
  }
}
