import { NextRequest } from 'next/server';
import { removeManager } from '@/lib/app-sharing';
import { NOT_FOUND } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'DELETE, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/** DELETE /api/me/team-apps/:id/managers/:personId - take a manager off. The universe's owner always manages, so it never has none. */
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ connectionId: string; personId: string }> }) {
  return appsRoute(request, METHODS, 'removing a manager', async (user, respond) => {
    const { connectionId, personId } = await params;
    if (!(await removeManager(user.id, connectionId, personId))) return respond({ error: NOT_FOUND }, 404);
    return respond({}, 204);
  });
}
