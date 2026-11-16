import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { corsHeaders } from '@/lib/cors';
import { getGitHubApp } from '@/lib/github/app';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
}

/**
 * GET /api/admin/github-app - whether Universe's GitHub App has been made yet (game #2041), for the "GitHub for Universe" row on
 * Orbit home. Nothing secret leaves: only whether it is made and where it lives on GitHub. Super admins only.
 */
export async function GET(request: NextRequest) {
  const headers = { ...corsHeaders(request), 'Cache-Control': 'no-store' };
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers });
  if (!user.isSuperAdmin) return NextResponse.json({ error: 'Only a super admin can see GitHub for Universe' }, { status: 403, headers });
  const app = await getGitHubApp();
  return NextResponse.json({ made: app !== null, ...(app ? { slug: app.slug, url: app.htmlUrl } : {}) }, { headers });
}
