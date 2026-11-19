import { NextRequest } from 'next/server';
import { readInstallState, readReturnState } from '@/lib/github/connection';
import { popupRedirect } from '@/lib/github/popup';

export const runtime = 'nodejs';

/**
 * GET /api/github/callback?code&state - GitHub sends the person back here after they signed in through Universe's GitHub App
 * (game #2041). Two ways arrive here, and both end the same:
 *  - combined: the person pressed Install & Authorize on GitHub's install page ("sign in during install", on), so GitHub signs them
 *    in at the end of the install and returns `code`, `installation_id`, `setup_action` and the install page's `state`;
 *  - separate: the sign-in page Orbit opened (before the app was installed anywhere, or for a Reconnect) returns `code` and its own `state`.
 * Nothing is exchanged here: GitHub's return carries no sign-in of ours, so anyone holding a sign-in address could otherwise land
 * their own GitHub on someone else's connection (or the other way round). The code goes on to the small return page of the window that
 * opened the sign-in (the game, an address of ours checked when the sign-in started), which hands it to that window only; that window
 * finishes it with the person's own sign-in (POST /api/me/apps/github/finish), which must be the person who started it, with a
 * ticket that works once.
 *
 * Returns that carry no sign-in to finish still close the window cleanly: an organization member's request for an owner's OK
 * (`setup_action=request`), and a return from an install page that was opened with no ticket of ours ("Add a place", "Ask an
 * owner"). Where the app works is read from GitHub each time, so nothing needs to be kept.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const rawState = searchParams.get('state');
  const code = searchParams.get('code');
  const refused = searchParams.get('error');
  const setupAction = searchParams.get('setup_action');
  const state = readReturnState(rawState);
  if (state && rawState) {
    if (refused) return popupRedirect(state.redirectUrl, { oauth: 'error', message: refused });
    if (!code) {
      // Asked an owner for the app: nothing to sign in with yet
      if (setupAction === 'request') return popupRedirect(state.redirectUrl, { oauth: 'success' });
      return popupRedirect(state.redirectUrl, { oauth: 'error', message: 'missing_code' });
    }
    return popupRedirect(state.redirectUrl, { oauth: 'github', code, state: rawState });
  }
  if (!refused && setupAction) {
    // An install page opened by an older version (a state with no person in it) or with no state at all: the window closes, nothing is signed in
    return popupRedirect(readInstallState(rawState)?.redirectUrl ?? null, { oauth: 'success' });
  }
  return popupRedirect(null, { oauth: 'error', message: 'sign_in_expired' });
}
