import { NextRequest } from 'next/server';
import { leaseVoiceNoteStage } from '@/lib/voice-note-turns';
import { voiceNoteRoute } from '@/lib/voice-note-routes';

export const runtime = 'nodejs';

/**
 * POST /api/voice-notes/turns/:id/lease
 * Asks to run a stage of a voice note: { stage: "hearing" | "answer", adapters }. Answers { granted: true, generation, leaseUntil,
 * hearing? (with the key, checked again now), reconcile?, transcript? } or { granted: false, reason }. See lib/voice-note-turns.ts.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return voiceNoteRoute(request, 'lease a voice note stage', (body) => leaseVoiceNoteStage(id, body));
}
