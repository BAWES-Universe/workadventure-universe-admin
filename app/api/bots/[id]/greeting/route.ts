import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { claimGreeting } from '@/lib/bot-greetings';

export const runtime = 'nodejs';

/**
 * POST /api/bots/:id/greeting
 * May this bot greet this person on its own now (greetings cooldown)? Asked by the bot server just before it would make a greeting.
 * A yes is remembered at once, so the next yes for the same bot and person comes only after the cooldown.
 * Body: { userId: their WorkAdventure uuid or email, isGuest: boolean }.
 * Response: { greet: true, greetedAt? } or { greet: false, nextAt }. See lib/bot-greetings.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    return NextResponse.json(await claimGreeting(id, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ReplyAllowanceError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'bot-greetings' } });
    console.error('[BotGreetings] Check failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
