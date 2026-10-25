import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { isPushEndpoint, readPushDeviceInput, registerPushDevice, removePushDeviceByEndpoint } from '@/lib/push-devices';
import { vapidPublicKey } from '@/lib/push-vapid';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

async function readJson(request: NextRequest): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** POST /api/me/push/devices { endpoint, keys: { p256dh, auth }, label } - saves this browser's subscription. */
export async function POST(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  if (!vapidPublicKey()) return respond(request, { error: 'Notifications are not set up' }, 503);

  const input = readPushDeviceInput(await readJson(request));
  if (!input) return respond(request, { error: 'Expected a push subscription from a supported browser' }, 400);
  try {
    return respond(request, { device: await registerPushDevice(user.id, input) });
  } catch (error) {
    console.error('[Push] Register failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

/** DELETE /api/me/push/devices { endpoint } - signing out on this browser: nothing arrives here afterwards. */
export async function DELETE(request: NextRequest) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  const body = await readJson(request);
  const endpoint = typeof body === 'object' && body !== null ? (body as { endpoint?: unknown }).endpoint : undefined;
  if (!isPushEndpoint(endpoint)) return respond(request, { error: 'Expected { endpoint }' }, 400);
  try {
    // Already gone counts as done: sign-out must never be stuck on it.
    await removePushDeviceByEndpoint(user.id, endpoint);
    return respond(request, { status: 'removed' });
  } catch (error) {
    console.error('[Push] Remove failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
