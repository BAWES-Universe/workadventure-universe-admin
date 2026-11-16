import { NextRequest } from 'next/server';
import { readInstallState } from '@/lib/github/connection';
import { popupRedirect } from '@/lib/github/popup';

export const runtime = 'nodejs';

/**
 * GET /api/github/installed?installation_id&setup_action&state - GitHub sends the person here after they picked where Universe's
 * GitHub App works (or asked an owner for it). Nothing is stored: where it works is read from GitHub each time. The sign-in window
 * is closed with success; an owner's OK that is still waiting shows on the app's page.
 */
export async function GET(request: NextRequest) {
  const state = readInstallState(new URL(request.url).searchParams.get('state'));
  return popupRedirect(state?.redirectUrl ?? null, { oauth: 'success' });
}
