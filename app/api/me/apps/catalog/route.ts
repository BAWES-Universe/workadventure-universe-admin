import { NextRequest } from 'next/server';
import { listCatalogForPerson } from '@/lib/app-catalog';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/apps/catalog?q= - "Connect another": the apps a super admin put on the list, narrowed by what the person typed in
 * Search apps, each with the id of their own connection when they have one. Never the link or the sign-in of an entry.
 */
export async function GET(request: NextRequest) {
  return appsRoute(request, METHODS, 'listing the apps to connect', async (user, respond) => {
    const q = request.nextUrl.searchParams.get('q') ?? undefined;
    return respond({ apps: await listCatalogForPerson(user.id, q?.slice(0, 100)) });
  });
}
