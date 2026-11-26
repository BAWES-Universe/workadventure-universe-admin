import { NextRequest } from 'next/server';
import { NOT_FOUND } from '@/lib/app-connections';
import { instantAppsForPerson } from '@/lib/instant/tools';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/apps/instant - the Apps page's "Ready to use": the research Apps every Brick of the person's searches with, with nothing to
 * connect: [{ key, name, blurb }], cheapest first. Never a price, an amount or the provider that runs them. An App the person connected
 * themselves is not listed (it is under Connected, and their own wins). 404 while there are none (Instant cannot run right now, or the
 * person has their own of every one), which the game reads as an empty list.
 */
export async function GET(request: NextRequest) {
  return appsRoute(request, METHODS, 'listing the apps ready to use', async (user, respond) => {
    const apps = await instantAppsForPerson(user.id);
    return apps.length > 0 ? respond({ apps }) : respond({ error: NOT_FOUND }, 404);
  });
}
