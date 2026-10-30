import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { VOICE_KEY_COMPANIES, VoiceKeyRefused, createVoiceKey, createVoiceKeySchema, listVoiceKeys } from '@/lib/voice-keys';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * GET /api/me/voice-keys - the caller's own voice keys (#749), never the key itself (only its last four characters), with
 * the universes each is lent to; and the speech companies a key can be added for.
 */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    return respond(request, { keys: await listVoiceKeys(user.id), companies: VOICE_KEY_COMPANIES });
  } catch (error) {
    console.error('[VoiceKeys] Could not list the keys:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

/**
 * POST /api/me/voice-keys { adapter, name?, recognition?, speech?, apiKey, models? } - adds a voice key for the caller.
 * The key listens, speaks or both, and lists the models it can be used with ({ id, label?, kind }); nothing is called at the
 * provider. Answers 201 with it.
 */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const body = await request.json().catch(() => null);
  const parsed = createVoiceKeySchema.safeParse(body);
  if (!parsed.success) return respond(request, { error: parsed.error.issues[0]?.message ?? 'Invalid request data' }, 400);
  try {
    return respond(request, { key: await createVoiceKey(user.id, parsed.data) }, 201);
  } catch (error) {
    if (error instanceof VoiceKeyRefused) return respond(request, { error: error.message }, error.status);
    console.error('[VoiceKeys] Could not add the key:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
