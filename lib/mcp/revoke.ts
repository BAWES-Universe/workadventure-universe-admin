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
    // One deadline for the whole of it: the name lookup of the destination check counts too, so a resolver that stalls cannot hold a disconnect
    const deadline = AbortSignal.timeout(REVOKE_TIMEOUT_MS);
    const late = new Promise<never>((_, reject) => deadline.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
    late.catch(() => undefined);
    if (!(await Promise.race([checkOutboundUrl(address), late])).allowed) return false;
    const hint = config.refreshToken ? 'refresh_token' : 'access_token';
    const send = (headers: Record<string, string>, body: URLSearchParams) =>
      fetch(address, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', ...headers },
        body: body.toString(),
        // A redirect would carry the token and the client secret somewhere the check never saw
        redirect: 'error',
        signal: deadline,
      });
    // First the client in the form body, as most apps take it
    const form = new URLSearchParams({ token, token_type_hint: hint });
    if (config.clientId) form.set('client_id', config.clientId);
    if (config.clientSecret) form.set('client_secret', config.clientSecret);
    const response = await send({}, form);
    if (response.ok) return true;
    // Some apps take the client's secret only in a Basic header (RFC 6749 2.3.1) and refuse the form with a 400 or 401: once more that way,
    // inside the same deadline. The secret is never sent twice in one request
    if ((response.status === 400 || response.status === 401) && config.clientId && config.clientSecret) {
      const basic = Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64');
      const again = await send({ Authorization: `Basic ${basic}` }, new URLSearchParams({ token, token_type_hint: hint }));
      return again.ok;
    }
    return false;
  } catch {
    return false;
  }
}
