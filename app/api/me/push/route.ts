import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { listPushDevices } from '@/lib/push-devices';
import { getPushSettings } from '@/lib/push-settings';
import { vapidPublicKey } from '@/lib/push-vapid';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'GET, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * GET /api/me/push - everything Settings > Notifications shows: the key a browser subscribes with (null while
 * notifications are not set up on this server), the caller's settings and their devices.
 */
export async function GET(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  try {
    const [settings, devices] = await Promise.all([getPushSettings(user.id), listPushDevices(user.id)]);
    return respond(request, { publicKey: vapidPublicKey(), settings, devices });
  } catch (error) {
    console.error('[Push] Read failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
