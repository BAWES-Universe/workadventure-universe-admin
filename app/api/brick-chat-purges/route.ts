import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';
import { CHAT_PURGES_PAGE, confirmChatPurges, pendingChatPurges } from '@/lib/brick-purge';

export const runtime = 'nodejs';

const pageSchema = z.object({ after: z.string().min(1).max(255).optional(), limit: z.coerce.number().int().min(1).max(500).optional() });
const confirmSchema = z.object({ botIds: z.array(z.string().min(1).max(255)).min(1).max(500) }).strict();

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

function failed(request: NextRequest, error: unknown, what: string) {
  if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
  }
  Sentry.captureException(error, { tags: { area: 'brick-purge' } });
  console.error(`Error ${what}:`, error instanceof Error ? error.message : 'unknown error');
  return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
}

/**
 * GET /api/brick-chat-purges
 * The Bricks purged for good whose chat rooms are still to clear (register R29; a deleted Brick keeps nothing): the Brick's id and nothing
 * else. Only the bot server holds the chat account, so it clears them (the Brick's own messages redacted, its profile blanked, its rooms
 * left and forgotten; what people said stays with them) and confirms with POST. A page is at most `limit` (default 100); `next` is what to pass
 * as `after` for the page behind it, or null at the end: a Brick that cannot be cleared for now stays listed and never hides the ones behind it.
 * Auth: BOT_SERVICE_TOKEN only.
 */
export async function GET(request: NextRequest) {
  try {
    requireServiceToken(request);
    const query = pageSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!query.success) return NextResponse.json({ error: 'Invalid request data', details: query.error.issues }, { status: 400, headers: corsHeaders(request) });
    const limit = query.data.limit ?? CHAT_PURGES_PAGE;
    const purges = await pendingChatPurges(limit, query.data.after);
    return NextResponse.json({ purges, next: purges.length === limit ? purges[purges.length - 1].botId : null }, { headers: corsHeaders(request) });
  } catch (error) {
    return failed(request, error, 'listing Bricks whose chats are to clear');
  }
}

/**
 * POST /api/brick-chat-purges
 * Body { botIds }: the bot server cleared these Bricks' chat rooms (or they never had any). Orbit forgets them as pending then, and not
 * before, so a restart in between loses none. Unknown ids are ignored. Auth: BOT_SERVICE_TOKEN only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const parsed = confirmSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request data', details: parsed.error.issues }, { status: 400, headers: corsHeaders(request) });
    return NextResponse.json({ confirmed: await confirmChatPurges(parsed.data.botIds) }, { headers: corsHeaders(request) });
  } catch (error) {
    return failed(request, error, 'confirming cleared chats');
  }
}
