import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { corsHeaders } from '@/lib/cors';
import { forgetGitHubApp, getGitHubApp, keptGitHubAppId } from '@/lib/github/app';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/admin/github-app - whether Universe's GitHub App has been made yet (game #2041), for the "GitHub for Universe" setup
 * page, which waits for it while GitHub's window is open. Nothing secret leaves: only whether it is made, which app it is (its number) and where it lives on GitHub. Super admins only. Whether it is made is read
 * straight from the store, so a store that cannot be read answers 500 (the row stays away) and never "not made".
 */
export async function GET(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (!user.isSuperAdmin) return NextResponse.json({ error: 'Only a super admin can see GitHub for Universe' }, { status: 403, headers });
  let kept: number | null;
  try {
    kept = await keptGitHubAppId();
  } catch (error) {
    console.error('[GitHubApp] Could not tell whether the app is made:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Could not tell whether GitHub is set up' }, { status: 500, headers });
  }
  if (kept === null) return NextResponse.json({ made: false }, { headers });
  // The address comes from this server's copy of the app (kept up to a minute); when it is not the app the store holds now (another
  // server just made or replaced it), read it again, and never answer with another app's address next to this app's number
  let app = await getGitHubApp();
  if (app?.appId !== kept) {
    forgetGitHubApp();
    app = await getGitHubApp();
  }
  if (app?.appId !== kept) app = null;
  // The app's id is no secret: the setup page tells a newly made app from the one it replaces by it
  return NextResponse.json({ made: true, appId: kept, ...(app ? { slug: app.slug, url: app.htmlUrl } : {}) }, { headers });
}
