import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { encryptApiKey } from '@/lib/encryption';
import { buildManifest, getGitHubApp, GITHUB_APP_ORG, GITHUB_WEB, orbitBase } from '@/lib/github/app';
import { escapeHtml, setupPage } from '@/lib/github/page';

export const runtime = 'nodejs';

/**
 * GET /api/admin/github-app/create - the one step a super admin takes to make Universe's GitHub App (game #2041): this page sends
 * GitHub's "Create GitHub App" page the whole form, already filled in, for the BAWES-Universe organization. They press Create
 * there, and GitHub sends them back to /api/admin/github-app/created, which keeps what it gives. Signed-in super admins only.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) return setupPage('Sign in to Orbit first', ['Open Orbit, sign in, then open this link again.'], 401);
  if (!user.isSuperAdmin) return setupPage('Not available', ['Only a super admin can set up GitHub for Universe.'], 403);
  const base = orbitBase();
  if (!base) return setupPage('Orbit is missing its address', ['ADMIN_API_URL is not set.'], 500);
  const existing = await getGitHubApp();
  const again = new URL(request.url).searchParams.get('again') === '1';
  if (existing && !again) {
    return setupPage('GitHub is already set up', [`Universe's GitHub App is ${existing.slug}. People can connect GitHub in Apps.`], 200, `<p><a href="${escapeHtml(existing.htmlUrl)}">Open it on GitHub</a></p>`);
  }
  // Who asked, and until when: the return is refused for anyone else or after an hour (GitHub's own limit for the code)
  const state = encryptApiKey(JSON.stringify({ kind: 'github-app-create', userId: user.id, exp: Math.floor(Date.now() / 1000) + 60 * 60 }));
  const action = `${GITHUB_WEB}/organizations/${GITHUB_APP_ORG}/settings/apps/new?state=${encodeURIComponent(state)}`;
  const form = `<form id="f" method="post" action="${escapeHtml(action)}"><input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(buildManifest(base)))}"><button type="submit">Continue to GitHub</button></form><script>document.getElementById('f').submit()</script>`;
  return setupPage('Opening GitHub…', ['GitHub opens with everything filled in. Press Create GitHub App there.'], 200, form);
}
