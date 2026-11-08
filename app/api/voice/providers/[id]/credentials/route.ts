import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { effectiveBotVoice, ownServerLentToBot } from '@/lib/bot-voice';
import { isOwnSpeechAdapter } from '@/lib/voice-own-server';

export const runtime = 'nodejs';

/**
 * GET /api/voice/providers/:id/credentials[?botId=...]
 * One voice provider that is on, with its key still encrypted (the bot server decrypts it with ENCRYPTION_KEY, as for the
 * text providers). A provider that is off, has no key or does not exist is not served.
 *
 * A key a person lent (#749) is served only with `botId`, and only while that bot speaks with it: voice is on for the bot, its
 * published profile names the key, and the bot's maker still has it lent to the bot's universe. Anything else is "not found".
 * The one exception is a speech server of the maker's own with `hello=1` (game #1874): while it is lent to the bot's universe it is
 * served for a "hear this voice name say hello" before voice is on.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
    const row = await prisma.voiceProvider.findUnique({ where: { id: (await params).id } });
    if (!row) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    if (row.ownerId !== null) {
      const botId = request.nextUrl.searchParams.get('botId');
      // The turn that was let through to try a Down key (voice/active) asks for it here, so health is left out of this check
      const voice = botId ? await effectiveBotVoice(botId, { ignoreKeyHealth: true }) : null;
      const usedBy = voice?.speaks && voice.profile ? [voice.profile.recognition.providerId, voice.profile.speech.providerId] : [];
      // A speech server of the maker's own may also be asked for a hello before voice is on (`hello=1`): a voice name typed for it is
      // heard first, and no profile names the server yet
      const forHello = request.nextUrl.searchParams.get('hello') === '1' && botId !== null && (await ownServerLentToBot(row, botId));
      if (!usedBy.includes(row.id) && !forHello) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    }
    if (!row.enabled) return NextResponse.json({ error: 'Provider is not enabled' }, { status: 400 });
    // A speech server on a person's own computer may have no key (game #1874); every other provider needs one
    if (!row.apiKeyEncrypted && !isOwnSpeechAdapter(row.adapter)) return NextResponse.json({ error: 'Provider has no key' }, { status: 400 });
    return NextResponse.json(
      {
        id: row.id,
        adapter: row.adapter,
        name: row.name,
        recognition: row.recognition,
        speech: row.speech,
        endpoint: row.endpoint,
        region: row.region,
        models: row.models,
        apiKeyEncrypted: row.apiKeyEncrypted,
        // Said out loud, so the bot server never takes a missing key for a mistake: only a speech server with no key is served without one
        ...(row.apiKeyEncrypted ? {} : { keyless: true }),
      },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof BotSettingsError) return NextResponse.json({ error: 'Provider not found' }, { status: 404 });
    Sentry.captureException(error, { tags: { area: 'voice-providers' } });
    console.error('[VoiceProviders] Could not serve the credentials:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
