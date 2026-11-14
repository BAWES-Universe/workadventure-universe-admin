import { NextRequest } from 'next/server';
import { z } from 'zod';
import { disconnect, ownBricks, readConnection, renameConnection, NOT_FOUND } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';
import { lendTargets, lentTo } from '@/lib/app-sharing';

export const runtime = 'nodejs';

const METHODS = 'GET, PATCH, DELETE, OPTIONS';
type Params = { params: Promise<{ connectionId: string }> };

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/** GET /api/me/apps/:id - one of the caller's apps with its Bricks, and the Bricks of theirs that do not use it yet. */
export async function GET(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'reading an app', async (user, respond) => {
    const { connectionId } = await params;
    const app = await readConnection(connectionId, user.id);
    if (!app) return respond({ error: NOT_FOUND }, 404);
    const bricks = await ownBricks(user.id);
    // "Lent to": where it is lent and what bots there do with it, and the universes it could still be lent to (empty when it cannot be lent)
    const [lent, targets] = app.lendable ? await Promise.all([lentTo(connectionId), lendTargets(user.id, connectionId)]) : [[], []];
    return respond({
      app,
      // A key app is available to all of the person's Bricks by default, so there is nothing to let in
      canLetUse: app.kind === 'direct' ? [] : bricks.filter((brick) => !app.bricks.some((used) => used.botId === brick.id)),
      lentTo: lent,
      canLendTo: targets.filter((universe) => !lent.some((row) => row.universeId === universe.id)),
    });
  });
}

const renameSchema = z.object({ name: z.string().trim().min(1).max(255) }).strict();

/** PATCH /api/me/apps/:id { name } - rename it. Its link and way in change only by connecting it again. */
export async function PATCH(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'renaming an app', async (user, respond) => {
    const { connectionId } = await params;
    const parsed = renameSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    if (!(await renameConnection(user.id, connectionId, parsed.data.name))) return respond({ error: NOT_FOUND }, 404);
    return respond({ id: connectionId, name: parsed.data.name });
  });
}

/**
 * DELETE /api/me/apps/:id - disconnect it: every Brick stops using it at once, every approval for it ends, and nothing in the
 * person's account at the app is deleted.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'disconnecting an app', async (user, respond) => {
    const { connectionId } = await params;
    if (!(await disconnect(user.id, connectionId))) return respond({ error: NOT_FOUND }, 404);
    return respond({}, 204);
  });
}
