import { NextRequest } from 'next/server';
import { markConnectionReconnected } from '@/lib/app-connections';
import { getGitHubApp } from '@/lib/github/app';
import { finishGitHubSignIn, installPageFor, readSignInState } from '@/lib/github/connection';
import { popupRedirect } from '@/lib/github/popup';

export const runtime = 'nodejs';

/**
 * GET /api/github/callback?code&state - GitHub sends the person back here after they signed in through Universe's GitHub App
 * (game #2041). Their token is kept in Orbit; when the app is not installed anywhere of theirs yet, they go straight on to pick
 * where it works, and the window closes after that.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const state = readSignInState(searchParams.get('state'));
  const code = searchParams.get('code');
  const refused = searchParams.get('error');
  if (!state) return popupRedirect(null, { oauth: 'error', message: 'sign_in_expired' });
  if (refused || !code) return popupRedirect(state.redirectUrl, { oauth: 'error', message: refused ?? 'missing_code' });
  const outcome = await finishGitHubSignIn(state, code);
  if (outcome.status === 'expired') return popupRedirect(state.redirectUrl, { oauth: 'error', message: 'sign_in_expired' });
  if (outcome.status !== 'done') return popupRedirect(state.redirectUrl, { oauth: 'error', message: outcome.status === 'gone' ? 'server_not_found' : 'token_exchange_failed' });
  await markConnectionReconnected(state.connectionId, state.personId);
  const app = await getGitHubApp();
  if (outcome.needsInstall && app) return Response.redirect(installPageFor(app, state.connectionId, state.redirectUrl), 302);
  return popupRedirect(state.redirectUrl, { oauth: 'success' });
}
