import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';
import { confirmFileRemovals, pendingFileRemovals } from '@/lib/brick-files';

export const runtime = 'nodejs';

const confirmSchema = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(500) }).strict();

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

function failed(request: NextRequest, error: unknown, what: string) {
  if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
  }
  Sentry.captureException(error, { tags: { area: 'brick-files' } });
  console.error(`Error ${what}:`, error instanceof Error ? error.message : 'unknown error');
  return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
}

/**
 * GET /api/bot-files/removals
 * The files people deleted from a Brick's list that are still in the uploader (game #2003): where each is, and nothing
 * else. The bot server removes them and confirms with POST. Auth: BOT_SERVICE_TOKEN only.
 */
export async function GET(request: NextRequest) {
  try {
    requireServiceToken(request);
    return NextResponse.json({ removals: await pendingFileRemovals() }, { headers: corsHeaders(request) });
  } catch (error) {
    return failed(request, error, 'listing files to remove');
  }
}

/**
 * POST /api/bot-files/removals
 * Body { ids }: the bot server removed these from the uploader, or they were gone already. Orbit forgets them then, and
 * not before, so a restart in between loses none. Auth: BOT_SERVICE_TOKEN only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const parsed = confirmSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid request data', details: parsed.error.issues }, { status: 400, headers: corsHeaders(request) });
    return NextResponse.json({ confirmed: await confirmFileRemovals(parsed.data.ids) }, { headers: corsHeaders(request) });
  } catch (error) {
    return failed(request, error, 'confirming removed files');
  }
}
