import { NextRequest } from 'next/server';
import { reserveVoiceNote } from '@/lib/voice-note-turns';
import { voiceNoteRoute } from '@/lib/voice-note-routes';

export const runtime = 'nodejs';

/**
 * POST /api/voice-notes/turns
 * Reserves one voice note before anything is paid: { scope: "bot" | "guest-brick", botId? | roomUrl?, userId, isGuest?,
 * clientTurnId, contentHash, seconds (measured from the audio), adapters, source? (bot: universe-ai | provider | own-key) }.
 * Answers { ok: true, turn, replay, answer? } or { ok: false, reason: reply-limit | note-minutes | busy | no-hearing | expired }.
 * The same turn asked again is never reserved again. See lib/voice-note-turns.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  return voiceNoteRoute(request, 'reserve a voice note', (body) => reserveVoiceNote(body));
}
