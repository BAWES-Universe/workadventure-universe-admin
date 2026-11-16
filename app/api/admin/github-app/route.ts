import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { corsHeaders } from '@/lib/cors';
import { getGitHubApp, keptGitHubAppId } from '@/lib/github/app';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/admin/github-app - whether Universe's GitHub App has been made yet (game #2041), for the "GitHub for Universe" row on
 * Orbit home. Nothing secret leaves: only whether it is made and where it lives on GitHub. Super admins only. Whether it is made is read
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
  const app = await getGitHubApp();
  return NextResponse.json({ made: true, ...(app ? { slug: app.slug, url: app.htmlUrl } : {}) }, { headers });
}
