import { NextRequest } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { decryptApiKey } from '@/lib/encryption';
import { gitHubRequest } from '@/lib/github/api';
import { saveGitHubApp, type ManifestConversion } from '@/lib/github/app';
import { setupPage } from '@/lib/github/page';

export const runtime = 'nodejs';

/**
 * GET /api/admin/github-app/created?code&state - where GitHub sends the super admin after they pressed Create. The code is turned
 * into the app's id, its secrets and its private key (once, within the hour), which Orbit keeps encrypted. From then on everyone
 * sees GitHub under Connect another.
 */
export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user?.isSuperAdmin) return setupPage('Sign in to Orbit first', ['Sign in to Orbit as a super admin, then press Create again from the setup link.'], 401);
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  let state: { kind?: string; userId?: string; exp?: number } | null = null;
  try {
    state = JSON.parse(decryptApiKey(searchParams.get('state') ?? ''));
  } catch {
    state = null;
  }
  if (!code || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) return setupPage('Something was missing', ['GitHub did not send the app back. Open the setup link again.'], 400);
  if (!state || state.kind !== 'github-app-create' || state.userId !== user.id || typeof state.exp !== 'number' || state.exp < Date.now() / 1000) {
    return setupPage('This setup link ran out', ['Open the setup link again and press Create once more.'], 400);
  }
  const answer = await gitHubRequest<ManifestConversion>(null, `/app-manifests/${code}/conversions`, { method: 'POST' }).catch(() => null);
  if (!answer?.ok || !answer.data?.id || !answer.data.pem || !answer.data.client_secret) {
    console.error('[GitHubApp] Conversion failed:', answer?.status ?? 'no answer');
    return setupPage('GitHub did not finish', ['The app may have been made on GitHub but Orbit could not keep it. Open the setup link again.'], 502);
  }
  const app = await saveGitHubApp(answer.data, user.id);
  console.log(`[GitHubApp] Made ${app.slug} (${app.appId})`);
  return setupPage('GitHub is set up', ['Everyone can now connect GitHub in Apps, and their Bricks work on GitHub as them.', 'You can close this page.']);
}
