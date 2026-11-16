import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { readAdapters, universeAiHearing } from '@/lib/voice-note-hearing';

export const runtime = 'nodejs';

/**
 * GET /api/guest-brick/hearing?adapters=soniox
 * What the Brick for guests hears a guest's voice notes with: Universe AI's listening provider only, never a person's key. The same
 * answer as /api/bots/:id/voice/hearing, with `route` "universe-ai" or "none". See lib/voice-note-hearing.ts.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest) {
  try {
    requireServiceToken(request);
    const adapters = readAdapters(request.nextUrl.searchParams.get('adapters'));
    if (!adapters) return NextResponse.json({ error: 'adapters is required' }, { status: 400 });
    return NextResponse.json(await universeAiHearing(adapters), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'voice-notes' } });
    console.error('[VoiceNotes] Could not read what the Brick for guests hears with:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
