import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { listServerVoices, VoiceListRefused } from '@/lib/voice-voices';

export const runtime = 'nodejs';

/**
 * GET /api/admin/voice-providers/:id/voices - the speaking voices of one of the server's providers, straight from the company's own
 * free list (#792; nothing is spoken or billed), for the starting voice on the Universe AI page. Works whether or not the provider is
 * the default. Answers `{ voices: [{ voiceId, name, description, languages, previewUrl }] }` in the company's order. 404 for no such
 * provider or one that doesn't speak, 409 when the company's voices can't be listed here or there is no key, 502 when the company
 * didn't answer or turned the key away. Super admin.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    return NextResponse.json({ voices: await listServerVoices((await params).id) });
  } catch (error) {
    if (error instanceof VoiceListRefused) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[VoiceProviders] Could not list the voices:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
