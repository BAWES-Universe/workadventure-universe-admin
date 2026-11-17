import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { admitHearingWindow } from '@/lib/voice-hearing-window';

export const runtime = 'nodejs';

/**
 * POST /api/bots/:id/voice-hearing-window
 * Admits a window of live hearing for a funded call (docs/speech-admission-contract.md, section 4), asked when a call starts hearing a person and
 * again in the background before the window is used up. Body: { userId, isGuest, windowId, provider?, model? }. Response: { allowed: true,
 * windowId, rateVersion, provider, admittedSeconds, renewAfterSeconds, admittedMicros }, or { allowed: false, resetsAt, stoppedBy,
 * retryAfterSeconds? }. The same windowId is the same window. See lib/voice-hearing-window.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    return NextResponse.json(await admitHearingWindow(id, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ReplyAllowanceError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'voice-hearing-window' } });
    console.error('[VoiceHearingWindow] Admission failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
