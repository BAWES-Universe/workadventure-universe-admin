import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { buildLiveView, fetchPresenceSnapshot } from '@/lib/live-presence';
import { meOriginAllowed, meRespond } from '@/lib/me-route';

export const runtime = 'nodejs';

// Orbit itself and the game, whose direct message profiles say where someone is from the same view (#596).
const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

// GET /api/live - who is where right now, as the caller may see it. `{ available: false }` when the game can't say.
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  const snapshot = await fetchPresenceSnapshot();
  if (!snapshot) return respond(request, { available: false });
  try {
    const view = await buildLiveView(snapshot, user);
    return respond(request, view);
  } catch (error) {
    console.error('[Live] Could not build the view:', error);
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
