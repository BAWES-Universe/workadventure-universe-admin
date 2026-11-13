import { decryptApiKey } from '@/lib/encryption';
import { checkOutboundUrl } from '@/lib/mcp/outbound-guard';
import { parseOAuthConfig } from '@/lib/mcp/oauth-token';

/**
 * Takes a person's sign-in back at the app when they disconnect it (RFC 7009), best effort and only when the app said where
 * (`revocationUrl` in the saved sign-in). It never decides whether the disconnect happened: the connection is already gone,
 * so every Brick has stopped, and nothing in the person's account at the app is deleted. Returns whether the app accepted it.
 * Never throws and never waits longer than a few seconds.
 */
export const REVOKE_TIMEOUT_MS = 5_000;

export async function revokeAtApp(connection: { authType: string; authConfig: string | null }): Promise<boolean> {
  try {
    if (connection.authType !== 'oauth' || !connection.authConfig) return false;
    const config = parseOAuthConfig(decryptApiKey(connection.authConfig));
    const address = (config as { revocationUrl?: unknown } | null)?.revocationUrl;
    const token = config?.refreshToken || config?.accessToken;
    if (!config || typeof address !== 'string' || !token) return false;
    // The token and the client secret go there, so never over plain http (RFC 7009), and the same destination check as the token endpoint, DNS included
    if (new URL(address).protocol !== 'https:') return false;
    if (!(await checkOutboundUrl(address)).allowed) return false;
    const body = new URLSearchParams({ token, token_type_hint: config.refreshToken ? 'refresh_token' : 'access_token' });
    if (config.clientId) body.set('client_id', config.clientId);
    if (config.clientSecret) body.set('client_secret', config.clientSecret);
    const response = await fetch(address, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
      // A redirect would carry the token and the client secret somewhere the check never saw
      redirect: 'error',
      signal: AbortSignal.timeout(REVOKE_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}
