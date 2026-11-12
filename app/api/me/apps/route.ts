import { NextRequest } from 'next/server';
import { z } from 'zod';
import { addConnectionSchema, createConnection, listConnections, ownBricks } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/apps - the apps the caller connected (game #2001), each with the Bricks of theirs that use it and what each may
 * do, and the Bricks they have. Never the link's way in (a key, a token), only whether it still works. Only theirs.
 */
export async function GET(request: NextRequest) {
  return appsRoute(request, METHODS, 'listing apps', async (user, respond) => {
    const [apps, bricks] = await Promise.all([listConnections(user.id), ownBricks(user.id)]);
    return respond({ apps, bricks });
  });
}

/**
 * POST /api/me/apps { name, serverUrl, authType, authConfig?, headers? } - connect an app by its link. Takes exactly what a bot's
 * own app takes, with the same checks. No Brick uses it until the person lets one (POST /api/me/apps/:id/bricks).
 */
export async function POST(request: NextRequest) {
  return appsRoute(request, METHODS, 'adding an app', async (user, respond) => {
    const parsed = addConnectionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data', details: z.treeifyError(parsed.error) }, 400);
    const connection = await createConnection(user.id, parsed.data);
    return respond({ id: connection.id, name: connection.name }, 201);
  });
}
