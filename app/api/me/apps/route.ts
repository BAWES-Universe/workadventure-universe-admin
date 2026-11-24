import { NextRequest } from 'next/server';
import { z } from 'zod';
import { unsendableIssueMessage } from '@/lib/mcp/server-input';
import { addLinkSchema, connectByLink, listConnections, ownBricks, NOT_FOUND } from '@/lib/app-connections';
import { connectFromCatalog } from '@/lib/app-catalog';
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
 * POST /api/me/apps { name, serverUrl, authType, authConfig?, headers?, requestKey? } - connect an app by its link, or { catalogKey } for
 * one of the list a super admin keeps. Takes exactly what a bot's own app takes, with the same checks. No Brick uses it until the
 * person lets one (POST /api/me/apps/:id/bricks).
 *
 * `requestKey` (optional, up to 200 characters) makes a repeat safe: the game sends one key per attempt, and the same key from the
 * same person answers the app it first made with 200 instead of making another (201 is the first time). A key that comes back with a
 * different link, name or sign-in kind is refused with 409. Without a key every request makes an app, as before.
 */
export async function POST(request: NextRequest) {
  return appsRoute(request, METHODS, 'adding an app', async (user, respond) => {
    const body = await request.json().catch(() => null);
    // "Connect" on an app of the list (GET /api/me/apps/catalog): { catalogKey }; the link and sign-in are the list's, never sent
    if (body && typeof body === 'object' && 'catalogKey' in body) {
      const key = (body as { catalogKey: unknown }).catalogKey;
      if (typeof key !== 'string' || !key) return respond({ error: 'Invalid input data' }, 400);
      const made = await connectFromCatalog(user.id, key);
      if (!made) return respond({ error: NOT_FOUND }, 404);
      return respond({ id: made.id }, made.created ? 201 : 200);
    }
    const parsed = addLinkSchema.safeParse(body);
    if (!parsed.success) return respond({ error: unsendableIssueMessage(parsed.error.issues) ?? 'Invalid input data', details: z.treeifyError(parsed.error) }, 400);
    const { requestKey, ...input } = parsed.data;
    const made = await connectByLink(user.id, input, requestKey);
    return respond({ id: made.id, name: made.name }, made.created ? 201 : 200);
  });
}
