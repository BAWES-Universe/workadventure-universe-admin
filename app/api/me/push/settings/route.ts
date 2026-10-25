import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { updatePushSettings } from '@/lib/push-settings';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'PATCH, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * PATCH /api/me/push/settings { directMessages?, friendRequests?, memberships?, friendInRoom?, friendLive?, dmFrom?,
 * previews?, quietHours? } - changes some of the caller's settings and answers with all of them.
 */
export async function PATCH(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(request, { error: 'Invalid JSON body' }, 400);
  }
  try {
    const settings = await updatePushSettings(user.id, body);
    if (!settings) return respond(request, { error: 'Unknown or invalid setting' }, 400);
    return respond(request, { settings });
  } catch (error) {
    console.error('[Push] Settings save failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
