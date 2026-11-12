import { NextRequest } from 'next/server';
import { removeGrant, NOT_FOUND } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'DELETE, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * DELETE /api/me/apps/:id/bricks/:botId - "Remove": the Brick stops using the app at once, also in a chat that is already open
 * and a goal that is already running; every approval for it ends and every open card for it is closed.
 */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ connectionId: string; botId: string }> }) {
  return appsRoute(request, METHODS, 'taking an app from a Brick', async (user, respond) => {
    const { connectionId, botId } = await params;
    if (!(await removeGrant(user.id, connectionId, botId))) return respond({ error: NOT_FOUND }, 404);
    return respond({}, 204);
  });
}
