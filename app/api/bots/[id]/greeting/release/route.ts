import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { releaseGreeting } from '@/lib/bot-greetings';

export const runtime = 'nodejs';

/**
 * POST /api/bots/:id/greeting/release
 * A greeting this bot claimed was not made after all (the AI said nothing or failed): it is forgotten, so the person is greeted
 * next time. Body: { userId, isGuest, greetedAt: what the claim answered }. Response: { released }. See lib/bot-greetings.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    return NextResponse.json(await releaseGreeting(id, body));
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ReplyAllowanceError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'bot-greetings' } });
    console.error('[BotGreetings] Release failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
