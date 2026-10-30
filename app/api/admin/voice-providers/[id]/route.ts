import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { VoiceProviderRefused, deleteVoiceProvider, updateVoiceProvider, updateVoiceProviderSchema, voiceProviderView } from '@/lib/voice-providers';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const denied = () => NextResponse.json({ error: 'Unauthorized: Super admin access required' }, { status: 403 });

function failure(error: unknown, doing: string) {
  if (error instanceof VoiceProviderRefused) return NextResponse.json({ error: error.message }, { status: error.status });
  // Two super admins made different providers the default at the same moment: the second one asks again
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002') {
    return NextResponse.json({ error: 'Another provider was just made the default. Check the list and try again' }, { status: 409 });
  }
  console.error(`[VoiceProviders] Could not ${doing}:`, error instanceof Error ? error.message : 'unknown');
  return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
}

/** GET /api/admin/voice-providers/:id - one provider, without its key. Super admin. */
export async function GET(request: NextRequest, { params }: Context) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return denied();
  try {
    const row = await prisma.voiceProvider.findUnique({ where: { id: (await params).id } });
    if (!row || row.ownerId !== null) return NextResponse.json({ error: 'Voice provider not found' }, { status: 404 });
    return NextResponse.json({ provider: voiceProviderView(row) });
  } catch (error) {
    return failure(error, 'read the provider');
  }
}

/**
 * PATCH /api/admin/voice-providers/:id - changes only what it names. `apiKey` sets a new key, `null` takes the key away;
 * `defaultRecognition` / `defaultSpeech` make it the default for listening / speaking and take that from the one that had it.
 * A default must be on, hold its key and do its job.
 */
export async function PATCH(request: NextRequest, { params }: Context) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return denied();
  const body = await request.json().catch(() => null);
  const parsed = updateVoiceProviderSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request data' }, { status: 400 });
  try {
    return NextResponse.json({ provider: voiceProviderView(await updateVoiceProvider((await params).id, parsed.data)) });
  } catch (error) {
    return failure(error, 'change the provider');
  }
}

/** DELETE /api/admin/voice-providers/:id - removes a provider that is not a default. */
export async function DELETE(request: NextRequest, { params }: Context) {
  const user = await getSessionUser(request);
  if (!user || !isSuperAdmin(user.email)) return denied();
  try {
    await deleteVoiceProvider((await params).id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return failure(error, 'remove the provider');
  }
}
