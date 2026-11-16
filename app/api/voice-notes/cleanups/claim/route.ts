import { NextRequest } from 'next/server';
import { claimVoiceNoteCleanups } from '@/lib/voice-note-cleanups';
import { voiceNoteRoute } from '@/lib/voice-note-routes';

export const runtime = 'nodejs';

/**
 * POST /api/voice-notes/cleanups/claim
 * The cleanups that are due, each held for 2 minutes, with the provider's key still encrypted: { limit? } -> { jobs }.
 * See lib/voice-note-cleanups.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  return voiceNoteRoute(request, 'hand out voice note cleanups', async (body) => ({ jobs: await claimVoiceNoteCleanups(body) }));
}
