import { NextRequest } from 'next/server';
import { recordVoiceNote } from '@/lib/voice-note-turns';
import { voiceNoteRoute } from '@/lib/voice-note-routes';

export const runtime = 'nodejs';

/**
 * PATCH /api/voice-notes/turns/:id
 * What happened in the stage the bot server holds: { event: submitted | heard | hearing-failed | answered | answer-failed |
 * delivered, generation, ... }. A bot server whose lease was taken over is refused (409). See lib/voice-note-turns.ts.
 *
 * Auth: service token only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return voiceNoteRoute(request, 'record a voice note', (body) => recordVoiceNote(id, body));
}
