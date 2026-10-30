import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { VoiceKeyRefused, lendVoiceKey } from '@/lib/voice-keys';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/voice-keys/:id/lend { universeId, models? } - lends one of the caller's voice keys to a universe where they
 * have Manage bots (or own it; the universes come from GET /api/me/ai-keys/universes). Lending moves no bot. Lending again is
 * fine and changes nothing, except the model list when one is sent.
 *
 * `models` says which of the key's models bots there may use, each as "kind:id" and each one on the key's list now: null =
 * all of them, left out = as it is (all, for a new lend). Answers with the key and where it is lent.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  const input = typeof body === 'object' && body !== null ? (body as { universeId?: unknown; models?: unknown }) : {};
  if (typeof input.universeId !== 'string' || !input.universeId) return respond(request, { error: 'Pick a universe first.' }, 400);
  try {
    return respond(request, { key: await lendVoiceKey(user.id, (await params).id, input.universeId, input.models) });
  } catch (error) {
    if (error instanceof VoiceKeyRefused) return respond(request, { error: error.message }, error.status);
    console.error('[VoiceKeys] Lend failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
