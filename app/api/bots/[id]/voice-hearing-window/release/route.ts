import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { releaseHearingWindow } from '@/lib/voice-hearing-window';

export const runtime = 'nodejs';

/**
 * POST /api/bots/:id/voice-hearing-window/release
 * Gives back what a window of live hearing did not use (docs/speech-admission-contract.md, section 4): the call or the window ended. Body:
 * { windowId }. Response: { released: true } when this call closed it, { released: false } when it was closed already or never admitted, so it
 * is safe to ask twice. What was heard stays counted (its events). See lib/voice-hearing-window.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return NextResponse.json({ error: 'Invalid request data' }, { status: 400 });
    return NextResponse.json(await releaseHearingWindow(id, body), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof ReplyAllowanceError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'voice-hearing-window' } });
    console.error('[VoiceHearingWindow] Release failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
