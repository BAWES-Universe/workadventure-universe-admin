import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { allowKeyAttempt } from '@/lib/ai-key-models';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { VoiceKeyRefused, reloadVoiceKeyModels } from '@/lib/voice-keys';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/voice-keys/:id/models - "Load models" on one of the caller's saved keys: its company is asked again with the saved
 * key (free: nothing is heard or spoken), and the models it lists now that the key doesn't have yet are added. Nothing is taken off.
 * Answers `{ models, added, unread }`: `models` the key's models as saved, `added` the models just added (`[]` when there are none) and `unread` the jobs (`"recognition"`,
 * `"speech"`, `"talk"`) whose list the company has but couldn't be read right now (`[]` when all were read). 404 not the caller's
 * key, 409 a key with no list to load (an own server, a typed Azure deployment, a company with no list, a key that does only jobs the company has no list for) or one that can't be read, 422 the company turned
 * the key away, 502 it couldn't be reached, or none of its lists could be read, 429 too many tries.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  if (!allowKeyAttempt(user.id)) return respond(request, { error: 'Too many tries. Wait a minute and try again.' }, 429);
  try {
    return respond(request, await reloadVoiceKeyModels(user.id, (await params).id));
  } catch (error) {
    if (error instanceof VoiceKeyRefused) return respond(request, { error: error.message }, error.status);
    console.error('[VoiceKeys] Load models again failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
