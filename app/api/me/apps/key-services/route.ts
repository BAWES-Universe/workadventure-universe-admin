import { NextRequest } from 'next/server';
import { listCatalog } from '@/lib/app-direct/catalog';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/** GET /api/me/apps/key-services - the services Universe ships a tested setup for (game #2044). A convenience: any other service works from a draft the owner confirms. */
export async function GET(request: NextRequest) {
  return appsRoute(request, METHODS, 'listing key services', async (_user, respond) => respond({ services: listCatalog() }));
}
