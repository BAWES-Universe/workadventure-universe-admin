import { NextRequest } from 'next/server';
import { z } from 'zod';
import { disconnect, renameConnection, NOT_FOUND } from '@/lib/app-connections';
import { readTeamApp, managerCandidates } from '@/lib/app-sharing';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, PATCH, DELETE, OPTIONS';
type Params = { params: Promise<{ connectionId: string }> };

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/team-apps/:id - one app that belongs to a universe: who connected it and whether they still manage it, who manages it
 * now, the bots that use it, this month's uses, and the people who could be added as managers. Only for its managers; anyone else
 * gets 404. To sign it in or Reconnect, a manager uses GET /api/me/apps/:id/sign-in.
 */
export async function GET(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'reading a universe app', async (user, respond) => {
    const { connectionId } = await params;
    const app = await readTeamApp(user.id, connectionId);
    if (!app) return respond({ error: NOT_FOUND }, 404);
    return respond({ app, canAddAsManager: (await managerCandidates(user.id, connectionId)) ?? [] });
  });
}

const renameSchema = z.object({ name: z.string().trim().min(1).max(255) }).strict();

/** PATCH /api/me/team-apps/:id { name } - rename it. */
export async function PATCH(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'renaming a universe app', async (user, respond) => {
    const { connectionId } = await params;
    const parsed = renameSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    if (!(await renameConnection(user.id, connectionId, parsed.data.name))) return respond({ error: NOT_FOUND }, 404);
    return respond({ id: connectionId, name: parsed.data.name });
  });
}

/** DELETE /api/me/team-apps/:id - disconnect it: every bot stops at once and every approval for it ends. */
export async function DELETE(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'disconnecting a universe app', async (user, respond) => {
    const { connectionId } = await params;
    if (!(await disconnect(user.id, connectionId))) return respond({ error: NOT_FOUND }, 404);
    return respond({}, 204);
  });
}
