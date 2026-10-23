import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { lendableUniverses } from '@/lib/ai-key-lend';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/** GET /api/me/ai-keys/universes - the universes where the caller may lend a key (they own it, or have Manage bots). */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    return respond(request, { universes: await lendableUniverses(user.id) });
  } catch (error) {
    console.error('[AiKeys] Universes failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
