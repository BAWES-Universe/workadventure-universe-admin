import { NextRequest } from 'next/server';
import { decryptApiKey } from '@/lib/encryption';
import { newSignInNonce, NOT_FOUND } from '@/lib/app-connections';
import { getManagedConnection } from '@/lib/app-team-access';
import { startOAuth } from '@/lib/mcp/oauth-start';
import { gitHubSignInUrl } from '@/lib/github/connection';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/apps/:id/sign-in?redirectUrl= - the address of the app's own sign-in page, for connecting it or for Reconnect.
 * The return fills the connection once, for every Brick that uses it, and only for this person.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ connectionId: string }> }) {
  return appsRoute(request, METHODS, 'starting a sign-in', async (user, respond) => {
    const { connectionId } = await params;
    const connection = await getManagedConnection(connectionId, user.id);
    if (!connection) return respond({ error: NOT_FOUND }, 404);
    // A person's GitHub signs in through Universe's GitHub App (game #2041)
    if (connection.source === 'github') {
      if (connection.ownerId !== user.id) return respond({ error: NOT_FOUND }, 404);
      const github = await gitHubSignInUrl(request, connectionId, user.id, await newSignInNonce(connectionId));
      if (!github.ok) return respond({ error: github.error }, github.status);
      return respond({ authorizeUrl: github.authorizeUrl });
    }
    if (connection.authType !== 'oauth' || !connection.authConfig) return respond({ error: 'This app does not sign in on a page' }, 400);
    let oauthConfig;
    try {
      oauthConfig = JSON.parse(decryptApiKey(connection.authConfig));
    } catch {
      return respond({ error: 'Failed to decrypt OAuth configuration' }, 500);
    }
    const started = startOAuth({
      request,
      oauthConfig,
      serverUrl: connection.serverUrl,
      fallbackPath: '/admin',
      state: { botId: '', serverId: '', connectionId, nonce: await newSignInNonce(connectionId), personId: user.id },
    });
    if (!started.ok) return respond({ error: started.error }, started.status);
    return respond({ authorizeUrl: started.authorizeUrl });
  });
}
