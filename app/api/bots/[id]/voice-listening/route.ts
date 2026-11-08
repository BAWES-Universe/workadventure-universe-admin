import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { reportListening } from '@/lib/voice-listening';

export const runtime = 'nodejs';

/**
 * POST /api/bots/:id/voice-listening
 * Add to a bot's daily listening and say whether the day's minutes are used (game #1859). Asked by the bot server with the seconds of
 * group speech it sent to the listening provider that were not said to the bot, and with no seconds (or 0) when it only wants to
 * know, for example when someone joins a bubble.
 * Body: { seconds?: 0 to 3600 }. Response: { spent, usedSeconds, limitSeconds, resetsAt }. The limit is the voice limit "listen minutes
 * a day" (or a lent listening key's own, #783); the day is the UTC day. See lib/voice-listening.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    return NextResponse.json(await reportListening(id, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ReplyAllowanceError || error instanceof BotSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'voice-listening' } });
    console.error('[VoiceListening] Report failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
