import { NextRequest } from 'next/server';
import { settleVoiceNoteCleanup } from '@/lib/voice-note-cleanups';
import { voiceNoteRoute } from '@/lib/voice-note-routes';

export const runtime = 'nodejs';

/**
 * PATCH /api/voice-notes/cleanups/:id
 * What the provider answered a delete with: { status, lease } or { failed: true, lease }. `lease` is required (400 without it) and is
 * copied unchanged from the claim response (POST /api/voice-notes/cleanups/claim). See lib/voice-note-cleanups.ts.
 *
 * Auth: service token only.
 */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return voiceNoteRoute(request, 'settle a voice note cleanup', (body) => settleVoiceNoteCleanup(id, body));
}
