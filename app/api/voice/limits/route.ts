import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { servedVoiceLimits } from '@/lib/voice-limits';

export const runtime = 'nodejs';

/**
 * GET /api/voice/limits
 * Every voice limit as a super admin set it (the recommended value for any never changed), a revision that goes up with
 * every save, and the voice replies they leave in today's fair usage windows. Read by the game with no deploy needed when a
 * default changes.
 * Response: { revision, limits: { textReserveShare, guestVoiceReplies, turnSeconds, replyCharacters, replySeconds,
 * listenMinutesPerDay, followUpSeconds }, window: { hours, signedIn: { replies, textReserve, voiceReplies }, guest: { ... } } }.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest) {
  try {
    requireServiceToken(request);
    return NextResponse.json(await servedVoiceLimits(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'voice-limits' } });
    console.error('[VoiceLimits] Could not serve the limits:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
