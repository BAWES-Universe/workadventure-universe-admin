import { NextRequest } from 'next/server';
import { lendApp, lendInputSchema } from '@/lib/app-sharing';
import { NOT_FOUND } from '@/lib/app-connections';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'POST, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * POST /api/me/apps/:id/lends { universeId, things?, usesPerDay? } - lend one of the caller's apps to a universe where they can manage
 * bots (game #2001, "Lend to a universe"). `things` is a list of lookUp, make, change, deleteSend, or null for all four; `usesPerDay`
 * a whole number or null for no limit. Lending moves no bot. Only an app added with a link and a key, a token or nothing can be
 * lent: one signed in as the person answers 409. A universe they cannot manage bots in answers 403. Asked again for the same
 * universe it changes the limits.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ connectionId: string }> }) {
  return appsRoute(request, METHODS, 'lending an app', async (user, respond) => {
    const { connectionId } = await params;
    const parsed = lendInputSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return respond({ error: 'Invalid input data' }, 400);
    const lent = await lendApp(user.id, connectionId, parsed.data);
    if (lent === 'not_found') return respond({ error: NOT_FOUND }, 404);
    if (lent === 'not_lendable') return respond({ error: 'This app is signed in as you, so it stays yours' }, 409);
    if (lent === 'no_access') return respond({ error: 'You cannot manage bots in that universe' }, 403);
    return respond({ universeId: lent.universeId, things: lent.things, usesPerDay: lent.usesPerDay }, 201);
  });
}
