import { NextRequest } from 'next/server';
import { NOT_FOUND } from '@/lib/app-connections';
import { thingsForOwnApp } from '@/lib/app-things';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/apps/:id/things - { things: ["Find Events", ...] }: what the app can do, by name, read from the app itself, for
 * "Connected · it can do 3 things". Only for the caller's own app (404 otherwise). An app that is not signed in or cannot be reached
 * right now answers an empty list, and the sheet says plain "Connected".
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ connectionId: string }> }) {
  return appsRoute(request, METHODS, 'reading what an app can do', async (user, respond) => {
    const { connectionId } = await params;
    const things = await thingsForOwnApp(connectionId, user.id);
    if (!things) return respond({ error: NOT_FOUND }, 404);
    return respond({ things });
  });
}
