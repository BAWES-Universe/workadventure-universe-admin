import { NextRequest } from 'next/server';
import { NOT_FOUND } from '@/lib/app-connections';
import { adapterIsOn } from '@/lib/app-adapter';
import { connectReadyMade, listReadyMadeForPerson } from '@/lib/app-adapter/ready-made';
import { safeReturnUrl } from '@/lib/app-adapter/return-url';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/apps/ready-made - the ready-made apps a person can connect with one tap: [{ key, name, connectionId }], where
 * `connectionId` is their own connection when they have one (it may not be signed in yet: the app's own page says so). 404 while the
 * adapter is off (no COMPOSIO_API_KEY), exactly like a route that does not exist.
 */
export async function GET(request: NextRequest) {
  if (!adapterIsOn()) return appsRoute(request, METHODS, 'listing ready-made apps', async (_user, respond) => respond({ error: NOT_FOUND }, 404));
  return appsRoute(request, METHODS, 'listing ready-made apps', async (user, respond) => respond({ apps: await listReadyMadeForPerson(user.id) }));
}

/**
 * POST /api/me/apps/ready-made { key, returnUrl? } - connect a ready-made app through the adapter (game #2001). While the adapter
 * is off (no COMPOSIO_API_KEY in Orbit's environment), this answers 404 exactly like a route that does not exist. Otherwise it
 * answers { id, redirectUrl }: send the person to `redirectUrl` to sign in on the app's own page. Asked again for an app the
 * person already has, it answers { id } (no redirectUrl) with 200.
 */
export async function POST(request: NextRequest) {
  if (!adapterIsOn()) return appsRoute(request, METHODS, 'connecting a ready-made app', async (_user, respond) => respond({ error: NOT_FOUND }, 404));
  return appsRoute(request, METHODS, 'connecting a ready-made app', async (user, respond) => {
    const body = (await request.json().catch(() => null)) as { key?: unknown; returnUrl?: unknown } | null;
    if (!body || typeof body.key !== 'string' || !body.key) return respond({ error: 'Invalid input data' }, 400);
    const made = await connectReadyMade(user.id, body.key, safeReturnUrl(request, body.returnUrl));
    if (!made) return respond({ error: NOT_FOUND }, 404);
    return respond({ id: made.id, ...(made.redirectUrl ? { redirectUrl: made.redirectUrl } : {}) }, made.created ? 201 : 200);
  });
}
