import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { effectiveBotVoice } from '@/lib/bot-voice';

export const runtime = 'nodejs';

/**
 * GET /api/bots/:id/voice/active
 * Whether the bot speaks right now and with what (#740): { speaks, reason, paidBy, parts, revision, profile, down, limits }. `reason`
 * is null when it speaks, and otherwise one of "off" (voice is off for the bot), "universe" (its universe doesn't allow voice
 * bots), "no-profile" (nothing published), "provider" (a provider in the profile is off, has no key, doesn't do that job or
 * no longer lists the model) or "key-down" (a person's key in the profile failed at its provider: the bot replies in text, and
 * `down` says since when and why). Read before each spoken turn, so a change stops it at once. A Down key is let through
 * `limits` is the server's voice limits (GET /api/voice/limits), except that a part that runs on a person's lent key takes the values
 * its owner set on that key (#783): `turnSeconds` and `listenMinutesPerDay` from the listening key, `replyCharacters` and
 * `replySeconds` from the speaking key. Every other limit is the server's. A Down key is let through
 * once every 5 minutes (#749): that turn speaks, and the bot server reports how the call went to
 * POST /api/voice/providers/:id/health.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const { id } = await params;
    return NextResponse.json(await effectiveBotVoice(id, { recheck: true }), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof BotSettingsError) return NextResponse.json({ error: error.message }, { status: error.status });
    Sentry.captureException(error, { tags: { area: 'bot-voice' } });
    console.error('[BotVoice] Could not read the voice:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
