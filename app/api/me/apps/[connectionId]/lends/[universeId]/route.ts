import { NextRequest } from 'next/server';
import { changeLend, lendChangeSchema, takeBack } from '@/lib/app-sharing';
import { NOT_FOUND } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'PATCH, DELETE, OPTIONS';
type Params = { params: Promise<{ connectionId: string; universeId: string }> };

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/** PATCH /api/me/apps/:id/lends/:universeId { things?, usesPerDay? } - "Change" the limits of a lend. */
export async function PATCH(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'changing a lend', async (user, respond) => {
    const { connectionId, universeId } = await params;
    const parsed = lendChangeSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    const lend = await changeLend(user.id, connectionId, universeId, parsed.data);
    if (!lend) return respond({ error: NOT_FOUND }, 404);
    return respond({ universeId: lend.universeId, things: lend.things, usesPerDay: lend.usesPerDay });
  });
}

/**
 * DELETE /api/me/apps/:id/lends/:universeId - take it back. Every bot there stops at once, in open chats too, and every approval
 * for them ends. Lending again later does not give it back to them.
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  return appsRoute(request, METHODS, 'taking an app back', async (user, respond) => {
    const { connectionId, universeId } = await params;
    if (!(await takeBack(user.id, connectionId, universeId))) return respond({ error: NOT_FOUND }, 404);
    return respond({}, 204);
  });
}
