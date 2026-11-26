import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { corsHeaders } from '@/lib/cors';
import { encryptApiKey } from '@/lib/encryption';
import { buildManifest, GITHUB_APP_ORG, GITHUB_WEB, orbitBase, readGitHubApp } from '@/lib/github/app';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * POST /api/admin/github-app/create { again? } - what the one-time setup page (/admin/github-app) sends GitHub's "Create GitHub App"
 * page: the address (the BAWES-Universe organization, with a state that names this super admin and lasts an hour) and the whole
 * filled-in form. The page posts it there, the super admin presses Create, and GitHub sends them back to
 * /api/admin/github-app/created. Answers { existing } instead when the app is already made, unless `again` is asked. Super admins only.
 */
export async function POST(request: NextRequest) {
  const headers = corsHeaders(request);
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (!user.isSuperAdmin) return NextResponse.json({ error: 'Only a super admin can set up GitHub for Universe' }, { status: 403, headers });
  const base = orbitBase();
  if (!base) return NextResponse.json({ error: 'ADMIN_API_URL environment variable is not configured' }, { status: 500, headers });
  const body = (await request.json().catch(() => null)) as { again?: unknown } | null;
  // The app and its id come from one read of the store: the app it sets out to replace is the one it saw, never one saved by another setup after it
  const { app: existing, appId: keptId } = await readGitHubApp();
  if (existing && body?.again !== true) return NextResponse.json({ existing: { slug: existing.slug, url: existing.htmlUrl, appId: existing.appId } }, { headers });
  // Who asked, until when, and which app it replaces (none for the first): the return is refused after an hour (GitHub's own limit for
  // the code), once they are no longer a super admin, or when the app kept is no longer the one it set out to replace
  // The app kept is read from the store itself when its secrets cannot be read (no app comes back then, but a row with an id is there):
  // the setup then replaces that one, not "the first app", which the return would refuse as another setup having finished
  const replaces = existing?.appId ?? keptId;
  const state = encryptApiKey(JSON.stringify({ kind: 'github-app-create', userId: user.id, replaces, exp: Math.floor(Date.now() / 1000) + 60 * 60 }));
  return NextResponse.json(
    // `replaces` is the app this very form replaces (none for the first): the page waits for another app than that one
    { action: `${GITHUB_WEB}/organizations/${GITHUB_APP_ORG}/settings/apps/new?state=${encodeURIComponent(state)}`, manifest: JSON.stringify(buildManifest(base)), replaces },
    { headers: { ...headers, 'Cache-Control': 'no-store' } },
  );
}
