import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';
import { resolveExpectedLoginOrigin } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { meOriginAllowed, meRespond } from '@/lib/me-route';
import { GATEWAY_PATH, PUSH_APP_ID } from '@/lib/push-gateway';

export const runtime = 'nodejs';

const respond = (request: NextRequest, body: unknown, status = 200) => meRespond(request, body, status, 'POST, OPTIONS');

export async function OPTIONS(request: NextRequest) {
  return respond(request, {}, request.headers.get('origin') && meOriginAllowed(request) ? 204 : 403);
}

/**
 * POST /api/me/push/devices/:id/pusher - what the game hands Synapse (`/_matrix/client/v3/pushers/set`) so direct
 * messages reach this device: Orbit's gateway address and the device's secret, made the first time it is asked for.
 * Someone else's device is a 404.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!meOriginAllowed(request)) return respond(request, { error: 'Origin not allowed' }, 403);
  const user = await getSessionUser(request);
  if (!user) return respond(request, { error: 'Unauthorized' }, 401);
  const origin = resolveExpectedLoginOrigin(process.env.NEXT_PUBLIC_API_URL || process.env.ADMIN_API_URL, '');
  if (!origin) return respond(request, { error: 'Notifications are not set up' }, 503);

  const { id } = await params;
  try {
    const device = await prisma.pushDevice.findFirst({ where: { id, userId: user.id }, select: { id: true, label: true, gatewaySecret: true } });
    if (!device) return respond(request, { error: 'Not found' }, 404);
    let secret = device.gatewaySecret;
    if (!secret) {
      secret = randomBytes(32).toString('base64url');
      // Only fills an empty one, so two tabs asking at once end up with the same secret
      await prisma.pushDevice.updateMany({ where: { id, gatewaySecret: null }, data: { gatewaySecret: secret } });
      secret = (await prisma.pushDevice.findUnique({ where: { id }, select: { gatewaySecret: true } }))?.gatewaySecret ?? secret;
    }
    const url = `${origin}${GATEWAY_PATH}`;
    return respond(request, {
      pusher: {
        kind: 'http',
        app_id: PUSH_APP_ID,
        pushkey: device.id,
        app_display_name: 'Universe',
        device_display_name: device.label,
        lang: 'en',
        data: { url, secret },
      },
    });
  } catch (error) {
    console.error('[Push] Pusher failed:', error instanceof Error ? error.message : 'unknown');
    return respond(request, { error: 'Internal server error' }, 500);
  }
}
