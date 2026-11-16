import { NextRequest } from 'next/server';
import { addVoiceNoteCleanup } from '@/lib/voice-note-cleanups';
import { voiceNoteRoute } from '@/lib/voice-note-routes';

export const runtime = 'nodejs';

/**
 * POST /api/voice-notes/cleanups
 * Something a listening provider still holds after a note: { providerId, region?, kind: "file" | "transcription", objectId }.
 * The same object twice is one job. See lib/voice-note-cleanups.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  return voiceNoteRoute(request, 'add a voice note cleanup', (body) => addVoiceNoteCleanup(body));
}
