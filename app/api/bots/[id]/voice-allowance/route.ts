import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { checkVoiceAllowance } from '@/lib/voice-allowance';

export const runtime = 'nodejs';

/**
 * POST /api/bots/:id/voice-allowance
 * May this reply be spoken (game #1669)? Asked by the bot server just before it says a reply that Universe AI pays for.
 * Body: { userId: their WorkAdventure uuid or email, isGuest: boolean, turnId: the reply's id }.
 * Response: { allowed: true }, or { allowed: false, resetsAt } when the person's spoken replies in this window are used up
 * (the reply stays in text). The same turnId is counted once, however often it is asked. See lib/voice-allowance.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    return NextResponse.json(await checkVoiceAllowance(id, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ReplyAllowanceError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'voice-allowance' } });
    console.error('[VoiceAllowance] Check failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
