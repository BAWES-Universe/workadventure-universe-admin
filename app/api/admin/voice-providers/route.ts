import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { VoiceProviderRefused, createVoiceProvider, createVoiceProviderSchema, listVoiceProviders, voiceProviderView } from '@/lib/voice-providers';

export const runtime = 'nodejs';

/**
 * GET /api/admin/voice-providers - the voice providers a super admin has set up for the server (#740). Never the key: only
 * whether there is one and its last four characters.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  try {
    return NextResponse.json({ providers: (await listVoiceProviders()).map(voiceProviderView) });
  } catch (error) {
    console.error('[VoiceProviders] Could not list the providers:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/admin/voice-providers { adapter, name, recognition?, speech?, enabled?, endpoint?, region?, apiKey?, models? }
 * Adds a provider, off until it is turned on. Answers 201 with it, or 400 with the line that says why not.
 */
export async function POST(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });
  const body = await request.json().catch(() => null);
  const parsed = createVoiceProviderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request data' }, { status: 400 });
  try {
    return NextResponse.json({ provider: voiceProviderView(await createVoiceProvider(parsed.data, user.id)) }, { status: 201 });
  } catch (error) {
    if (error instanceof VoiceProviderRefused) return NextResponse.json({ error: error.message }, { status: error.status });
    console.error('[VoiceProviders] Could not add the provider:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
