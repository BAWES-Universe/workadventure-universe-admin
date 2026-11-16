import { NextRequest, NextResponse } from 'next/server';
import { requireServiceToken } from '@/lib/service-tokens';
import { VOICE_NOTE_CAPABILITIES } from '@/lib/voice-note-capabilities';

export const runtime = 'nodejs';

/**
 * GET /api/voice-notes/capabilities
 * { voiceNotes: { v, hearing, reservations, turns, receipts, carry } }: which parts of voice notes for every bot this Orbit has.
 * See lib/voice-note-capabilities.ts.
 *
 * Auth: service token only.
 */
export async function GET(request: NextRequest) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json({ voiceNotes: VOICE_NOTE_CAPABILITIES }, { headers: { 'Cache-Control': 'no-store' } });
}
