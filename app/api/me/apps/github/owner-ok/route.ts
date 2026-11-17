import { NextRequest } from 'next/server';
import { NOT_FOUND } from '@/lib/app-connections';
import { prisma } from '@/lib/db';
import { GITHUB_CATALOG_KEY, openerUrl, ownerOkPage } from '@/lib/github/connection';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/apps/github/owner-ok?org=&redirectUrl= - "Ask the owner" on a Brick's card, for an organization that has not allowed
 * Universe's GitHub app (design 14 Nov, Part 3): answers { askUrl, ownKeyPage }, GitHub's own page for adding the app on that
 * organization (an owner installs it, anyone else sends the request that GitHub emails to the owners) and the page for a key of the
 * person's own. 404 when they have no GitHub connection or the name is not an organization; the window that opened the page is the one
 * the return goes back to (an address of ours, checked like every sign-in's).
 */
export async function GET(request: NextRequest) {
  return appsRoute(request, METHODS, 'asking an organization for GitHub', async (user, respond) => {
    const org = new URL(request.url).searchParams.get('org')?.trim() ?? '';
    const connection = await prisma.appConnection.findFirst({ where: { ownerId: user.id, catalogKey: GITHUB_CATALOG_KEY } });
    if (!connection || !org) return respond({ error: NOT_FOUND }, 404);
    const page = await ownerOkPage(connection, org, openerUrl(request), fetch);
    if (page.status === 'not_org') return respond({ error: NOT_FOUND }, 404);
    if (page.status !== 'ok') return respond({ error: 'GitHub could not be reached just now', code: 'unavailable' }, 502);
    return respond({ askUrl: page.askUrl, ownKeyPage: page.ownKeyPage });
  });
}
