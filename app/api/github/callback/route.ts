import { NextRequest } from 'next/server';
import { readSignInState } from '@/lib/github/connection';
import { popupRedirect } from '@/lib/github/popup';

export const runtime = 'nodejs';

/**
 * GET /api/github/callback?code&state - GitHub sends the person back here after they signed in through Universe's GitHub App
 * (game #2041). Nothing is exchanged here: GitHub's return carries no sign-in of ours, so anyone holding a sign-in address could
 * otherwise land their own GitHub on someone else's connection (or the other way round). The code goes on to the small return page
 * of the window that opened the sign-in (the game, an address of ours checked when the sign-in started), which hands it to that
 * window only; that window finishes it with the person's own sign-in (POST /api/me/apps/github/finish), which must be the person
 * who started it.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawState = searchParams.get('state');
  const state = readSignInState(rawState);
  const code = searchParams.get('code');
  const refused = searchParams.get('error');
  if (!state || !rawState) return popupRedirect(null, { oauth: 'error', message: 'sign_in_expired' });
  if (refused || !code) return popupRedirect(state.redirectUrl, { oauth: 'error', message: refused ?? 'missing_code' });
  return popupRedirect(state.redirectUrl, { oauth: 'github', code, state: rawState });
}
