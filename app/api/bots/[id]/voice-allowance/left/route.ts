import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { voiceRepliesLeft } from '@/lib/voice-allowance';

export const runtime = 'nodejs';

/**
 * POST /api/bots/:id/voice-allowance/left
 * How many spoken replies a person has left (game #1669), for the line at the bottom of their Voice menu. Counts nothing and starts no
 * window. Body: { userId: their WorkAdventure uuid or email, isGuest: boolean }.
 * Response: { left, resetsAt }: `left` is the spoken replies they can still hear (the replies kept for text are put aside), `resetsAt` is
 * when their 5-hour window ends, or null while none is running (they have used nothing). { left: null, resetsAt: null } when the bot
 * can't name the person. See lib/voice-allowance.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    const answer = await voiceRepliesLeft(id, body);
    return NextResponse.json(answer ?? { left: null, resetsAt: null }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ReplyAllowanceError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'voice-allowance' } });
    console.error('[VoiceAllowance] Left check failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
