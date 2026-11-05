import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { releaseVoiceReply } from '@/lib/voice-allowance';

export const runtime = 'nodejs';

/**
 * POST /api/bots/:id/voice-allowance/release
 * Give back a spoken reply that was counted but never played (game #1669): a person talked over it while it was being settled, a
 * greeting that waited for audio ran out of time, or the voice provider failed. Body: { turnId: the reply's id, as sent to
 * voice-allowance }. Response: { released: true } when a counted reply was given back, { released: false } when there was none
 * (never counted, or already given back), so it is safe to ask twice. See lib/voice-allowance.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    return NextResponse.json(await releaseVoiceReply(id, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ReplyAllowanceError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'voice-allowance' } });
    console.error('[VoiceAllowance] Release failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
