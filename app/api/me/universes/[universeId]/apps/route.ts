import { NextRequest } from 'next/server';
import { z } from 'zod';
import { createTeamApp, listTeamApps, teamAppSchema, teamAppView } from '@/lib/app-sharing';
import { NOT_FOUND } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, POST, OPTIONS';
type Params = { params: Promise<{ universeId: string }> };

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/universes/:universeId/apps - the apps that belong to this universe, not to one person, that the caller manages.
 * Someone who cannot manage bots there gets 404, the same as a universe that is not there.
 */
export async function GET(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'listing a universe\'s apps', async (user, respond) => {
    const { universeId } = await params;
    const apps = await listTeamApps(user.id, universeId);
    if (!apps) return respond({ error: NOT_FOUND }, 404);
    return respond({ apps });
  });
}

/**
 * POST /api/me/universes/:universeId/apps { name, serverUrl, authType, authConfig?, headers? } - connect an app that belongs to the
 * universe. Takes what a person's own app takes, with the same checks. The caller becomes its manager; it stays when they leave. No
 * bot uses it until a manager lets one. Needs Manage bots there; anyone else gets 404.
 */
export async function POST(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'adding a universe app', async (user, respond) => {
    const { universeId } = await params;
    const parsed = teamAppSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data', details: z.treeifyError(parsed.error) }, 400);
    const connection = await createTeamApp(user.id, universeId, parsed.data);
    if (!connection) return respond({ error: NOT_FOUND }, 404);
    const view = await teamAppView(connection, user.id);
    return respond({ id: connection.id, app: view }, 201);
  });
}
