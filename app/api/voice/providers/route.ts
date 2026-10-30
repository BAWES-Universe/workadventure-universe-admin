import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { servedVoiceProviders } from '@/lib/voice-providers';

export const runtime = 'nodejs';

/**
 * GET /api/voice/providers
 * The voice providers that are on, without their keys, and which are the defaults for listening and speaking (#740).
 * Response: { providers: [{ id, adapter, name, recognition, speech, endpoint, region, models, hasKey }],
 * defaults: { recognition: id | null, speech: id | null } }.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest) {
  try {
    requireServiceToken(request);
    return NextResponse.json(await servedVoiceProviders(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'voice-providers' } });
    console.error('[VoiceProviders] Could not serve the providers:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
