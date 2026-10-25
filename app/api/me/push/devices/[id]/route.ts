import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { removePushDevice, setPushDeviceEnabled } from '@/lib/push-devices';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'PATCH, DELETE, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/** PATCH /api/me/push/devices/:id { enabled } - the device's own switch. Someone else's device is a 404. */
export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return respond(request, { error: 'Invalid JSON body' }, 400);
  }
  const enabled = typeof body === 'object' && body !== null ? (body as { enabled?: unknown }).enabled : undefined;
  if (typeof enabled !== 'boolean') return respond(request, { error: 'Expected { enabled }' }, 400);

  const { id } = await params;
  try {
    if (!(await setPushDeviceEnabled(user.id, id, enabled))) return respond(request, { error: 'Not found' }, 404);
    return respond(request, { id, enabled });
  } catch (error) {
    console.error('[Push] Switch failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}

/** DELETE /api/me/push/devices/:id - Remove in Your devices. Someone else's device, or one already gone, is a 404. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const { id } = await params;
  try {
    if (!(await removePushDevice(user.id, id))) return respond(request, { error: 'Not found' }, 404);
    return respond(request, { status: 'removed' });
  } catch (error) {
    console.error('[Push] Remove failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
