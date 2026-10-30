import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { VoiceKeyRefused, deleteVoiceKey, updateVoiceKey, updateVoiceKeySchema } from '@/lib/voice-keys';

export const runtime = 'nodejs';

type Context = { params: Promise<{ id: string }> };

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'PATCH, DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * PATCH /api/me/voice-keys/:id { name?, apiKey?, models? } - changes only what it names, on the caller's own key. A new
 * `apiKey` replaces the saved one. A model taken off the key is taken off every lend that named it. Someone else's key,
 * and a server provider, are "not found".
 */
export async function PATCH(request: NextRequest, { params }: Context) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  const parsed = updateVoiceKeySchema.safeParse(body);
  if (!parsed.success) return respond(request, { error: parsed.error.issues[0]?.message ?? 'Invalid request data' }, 400);
  try {
    return respond(request, { key: await updateVoiceKey(user.id, (await params).id, parsed.data) });
  } catch (error) {
    if (error instanceof VoiceKeyRefused) return respond(request, { error: error.message }, error.status);
    console.error('[VoiceKeys] Could not change the key:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * DELETE /api/me/voice-keys/:id - takes the caller's key away, with every lend of it. Bots whose voice named it carry on in text.
 */
export async function DELETE(request: NextRequest, { params }: Context) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    await deleteVoiceKey(user.id, (await params).id);
    return respond(request, { status: 'removed' });
  } catch (error) {
    if (error instanceof VoiceKeyRefused) return respond(request, { error: error.message }, error.status);
    console.error('[VoiceKeys] Could not remove the key:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
