import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { BotSettingsError } from '@/lib/bot-access-settings';
import { ReplyAllowanceError } from '@/lib/reply-limits';
import { VoiceNoteError } from '@/lib/voice-note-turns';
import { VoiceNoteCleanupError } from '@/lib/voice-note-cleanups';

/**
 * The voice note routes the bot server calls (service token only): the body read as JSON, each library's refusal as its status,
 * anything else reported and answered 500 with nothing about it.
 */
export async function voiceNoteRoute(request: NextRequest, what: string, run: (body: Record<string, unknown>) => Promise<unknown>) {
  try {
    requireServiceToken(request);
    let body: unknown = {};
    if (request.method !== 'GET') {
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ error: 'Expected a JSON body' }, { status: 400 });
      }
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return NextResponse.json({ error: 'Expected an object' }, { status: 400 });
    return NextResponse.json(await run(body as Record<string, unknown>), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    if (error instanceof VoiceNoteError || error instanceof VoiceNoteCleanupError || error instanceof BotSettingsError || error instanceof ReplyAllowanceError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    Sentry.captureException(error, { tags: { area: 'voice-notes' } });
    console.error(`[VoiceNotes] Could not ${what}:`, error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
