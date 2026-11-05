import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { fetchServerVoiceSample, VoiceListRefused } from '@/lib/voice-voices';

export const runtime = 'nodejs';

/**
 * GET /api/admin/voice-providers/:id/voices/:voiceId/preview - one voice's free sample, for a company that keeps it behind the key
 * (a voice from the list whose `previewUrl` is this path). The audio comes from the address the company's own list named, never
 * from one in the request, and the key never leaves Orbit. Same errors as the list. Super admin.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; voiceId: string }> }) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    const { id, voiceId } = await params;
    const sample = await fetchServerVoiceSample(id, voiceId);
    return new NextResponse(sample.bytes, { headers: { 'Content-Type': sample.contentType, 'Cache-Control': 'private, max-age=86400' } });
  } catch (error) {
    if (error instanceof VoiceListRefused) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[VoiceProviders] Could not get the voice sample:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
