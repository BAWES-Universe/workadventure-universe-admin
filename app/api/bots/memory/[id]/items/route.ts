import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';
import { forgetItemKey } from '@/lib/bot-memory-person';
import { MEMORY_ITEM_KINDS } from '@/lib/bot-memory-items';

export const runtime = 'nodejs';

/** The bot server gives up on a report after a day, so an older time than that is not believed. */
const ASKED_AT_MOST_MS = 24 * 60 * 60 * 1000;

const bodySchema = z
  .object({
    userUuid: z.string().min(1).max(255),
    itemKey: z.string().regex(/^[0-9a-f]{32}$/),
    kind: z.enum(MEMORY_ITEM_KINDS),
    /** When the person asked (milliseconds), when the bot server had to retry the report. Read within the last day, never in the future. */
    at: z.number().int().positive().optional(),
  })
  .strict();

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * POST /api/bots/memory/:botId/items
 * The bot server tells Orbit a person made the bot forget one thing in the chat ("forget that"), by the key of what it
 * said (game #2003, the same key as lib/bot-memory-items.ts). The key is kept as forgotten and a saved row that holds
 * it loses it. The bot server may hold a thing Orbit has not saved yet, so a row is not needed. Nothing else is read or
 * written, and there is no list here: a person's list is theirs, through /api/bots/:id/my-memory.
 *
 * Auth: BOT_SERVICE_TOKEN only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id: botId } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request data', details: parsed.error.issues }, { status: 400, headers: corsHeaders(request) });
    const now = Date.now();
    const at = parsed.data.at === undefined ? undefined : new Date(Math.min(now, Math.max(now - ASKED_AT_MOST_MS, parsed.data.at)));
    await forgetItemKey(botId, parsed.data.userUuid, parsed.data.itemKey, parsed.data.kind, at);
    return NextResponse.json({ forgotten: true }, { headers: corsHeaders(request) });
  } catch (error: unknown) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
    }
    Sentry.captureException(error, { tags: { area: 'bot-memory' } });
    console.error('Error saving that a thing was forgotten:', error instanceof Error ? error.message : 'unknown error');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
  }
}
