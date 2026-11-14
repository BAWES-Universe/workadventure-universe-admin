import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { botHearing, readAdapters } from '@/lib/voice-note-hearing';

export const runtime = 'nodejs';

/**
 * GET /api/bots/:id/voice/hearing?adapters=soniox
 * What the bot hears voice notes with now, whatever its Voice switch and its universe's "Allow voice bots" say (those are only
 * about talking live): { v, route, reason, payer, provider, model, language }. `route` is "owner-key" (a key of its maker's that
 * its published profile names for listening; the owner pays), "universe-ai" (Universe AI's listening provider; Universe AI pays,
 * from the person's allowances) or "none" (the mic hides). `adapters` names the providers the bot server can send a file to; a
 * provider it can't is never named. `provider.apiKeyEncrypted` is the key, encrypted as for /api/voice/providers/:id/credentials.
 * See lib/voice-note-hearing.ts.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const adapters = readAdapters(request.nextUrl.searchParams.get('adapters'));
    if (!adapters) return NextResponse.json({ error: 'adapters is required' }, { status: 400 });
    const { id } = await params;
    return NextResponse.json(await botHearing(id, adapters), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof BotSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'voice-notes' } });
    console.error('[VoiceNotes] Could not read what a bot hears with:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
