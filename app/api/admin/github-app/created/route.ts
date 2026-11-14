import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db';
import { decryptApiKey } from '@/lib/encryption';
import { gitHubRequest } from '@/lib/github/api';
import { saveGitHubApp, type ManifestConversion } from '@/lib/github/app';
import { setupPage } from '@/lib/github/page';
import { isSuperAdmin } from '@/lib/super-admin';

export const runtime = 'nodejs';

/**
 * GET /api/admin/github-app/created?code&state - where GitHub sends the super admin after they pressed Create. The code is turned
 * into the app's id, its secrets and its private key (once, within the hour), which Orbit keeps encrypted. From then on everyone
 * sees GitHub under Connect another.
 *
 * GitHub's redirect carries no Orbit sign-in (Orbit signs in with a header, never a cookie), so the state is the proof: Orbit made
 * it, encrypted, for a super admin, an hour ago at most, and that person must still be a super admin now.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  let state: { kind?: string; userId?: string; exp?: number } | null = null;
  try {
    state = JSON.parse(decryptApiKey(searchParams.get('state') ?? ''));
  } catch {
    state = null;
  }
  if (!code || !/^[A-Za-z0-9_-]{1,200}$/.test(code)) return setupPage('Something was missing', ['GitHub did not send the app back. Open the setup page again.'], 400);
  if (!state || state.kind !== 'github-app-create' || typeof state.userId !== 'string' || typeof state.exp !== 'number' || state.exp < Date.now() / 1000) {
    return setupPage('This setup ran out', ['Open the setup page in Orbit again and press Create once more.'], 400);
  }
  const asker = await prisma.user.findUnique({ where: { id: state.userId }, select: { email: true } });
  if (!asker || !isSuperAdmin(asker.email)) return setupPage('Not available', ['Only a super admin can set up GitHub for Universe.'], 403);
  const answer = await gitHubRequest<ManifestConversion>(null, `/app-manifests/${code}/conversions`, { method: 'POST' }).catch(() => null);
  if (!answer?.ok || !answer.data?.id || !answer.data.pem || !answer.data.client_secret) {
    console.error('[GitHubApp] Conversion failed:', answer?.status ?? 'no answer');
    return setupPage('GitHub did not finish', ['Orbit could not keep the app GitHub made. Open the setup page in Orbit again.'], 502);
  }
  const app = await saveGitHubApp(answer.data, state.userId);
  console.log(`[GitHubApp] Made ${app.slug} (${app.appId})`);
  return setupPage('GitHub is set up', ['Everyone can now connect GitHub in Apps, and their Bricks work on GitHub as them.', 'You can close this page.']);
}
