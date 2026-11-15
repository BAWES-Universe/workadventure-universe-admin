import { NextRequest } from 'next/server';
import { appsRoute, preflight } from '@/lib/me-apps-route';
import { listPageJobs } from '@/lib/app-direct/pay';

export const runtime = 'nodejs';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/** GET /api/me/apps/pages[?connectionId=] - the pages of the caller's that take payments, with what each has taken (game #2044). Only theirs. */
export async function GET(request: NextRequest) {
  return appsRoute(request, METHODS, 'listing pages that take payments', async (user, respond) => {
    const connectionId = request.nextUrl.searchParams.get('connectionId') || undefined;
    return respond({ pages: await listPageJobs(user.id, connectionId) });
  });
}
