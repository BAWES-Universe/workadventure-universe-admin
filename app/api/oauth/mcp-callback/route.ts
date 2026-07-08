import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import { getOAuthCallbackBase } from '@/lib/oauth-callback';

export const runtime = 'nodejs';

/** OAuth provider config stored in the MCP server's authConfig. */
interface OAuthConfig {
  clientId: string;
  clientSecret?: string;
  authorizeUrl?: string;
  tokenUrl: string;
  scopes?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

/**
 * GET /api/oauth/mcp-callback
 *
 * OAuth 2.0 callback endpoint for MCP server connections.
 * Receives the authorization code from the provider, exchanges it for tokens
 * using the provider's token endpoint stored in the server's authConfig,
 * and saves the encrypted tokens.
 *
 * This endpoint is fully provider-agnostic — every MCP server config stores
 * its own authorizeUrl, tokenUrl, clientId, and clientSecret.
 *
 * Query params (from OAuth provider):
 *   code  — authorization code
 *   state — encrypted state token containing {botId, serverId, redirectUrl, codeVerifier}
 *   error — optional error from provider
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const state = searchParams.get('state');
    const errorParam = searchParams.get('error');

    // Redirect to the popup callback page on the opener's origin.
    // The redirectUrl from the state token is the page that opened the popup
    // (e.g. universe.bawes.net for play, orbit.bawes.net for admin).
    // Using its origin ensures the callback page is same-origin with the opener,
    // so postMessage and window.close() work correctly.
    const callbackBase = getOAuthCallbackBase();
    if (!callbackBase) {
      return new NextResponse('ADMIN_API_URL environment variable is not configured', { status: 500 });
    }
    const adminBase = callbackBase;

    // Helper: build redirect to the OAuth popup callback page on the opener's origin
    const popupRedirect = (base: string, params: Record<string, string>): NextResponse => {
      return NextResponse.redirect(
        new URL('/oauth-popup-callback?' + new URLSearchParams(params).toString(), base)
      );
    };

    // Resolve the opener's origin — the page that opened the popup (play or admin domain)
    const getOpenerBase = (rd: string | undefined): string =>
      rd ? new URL(rd).origin : adminBase;

    // Handle provider-level error (user denied, etc.)
    // State token may not be parsed yet at this point, fall back to adminBase.
    if (errorParam) {
      console.error('[OAuthCallback] Provider error:', errorParam);
      let errorBase = adminBase;
      try {
        const partialState = parseStateToken(state);
        if (partialState?.redirectUrl) {
          errorBase = new URL(partialState.redirectUrl).origin;
        }
      } catch {
        // State isn't parseable — use adminBase fallback
      }
      return popupRedirect(errorBase, {
        oauth: 'error',
        message: errorParam,
      });
    }

    if (!code || !state) {
      return new NextResponse('Missing code or state parameter', { status: 400 });
    }

    // Decrypt state to get botId, serverId, redirectUrl, codeVerifier
    const stateData = parseStateToken(state);
    if (!stateData) {
      return new NextResponse('Invalid state token', { status: 400 });
    }

    const { botId, serverId, redirectUrl, codeVerifier, redirectUri } = stateData;
    const openerBase = getOpenerBase(redirectUrl);

    // Load the MCP server config to get OAuth provider config
    const server = await prisma.botMcpServer.findUnique({
      where: { id: serverId },
      select: { id: true, botId: true, authType: true, authConfig: true },
    });

    if (!server || server.botId !== botId || server.authType !== 'oauth') {
      console.error('[OAuthCallback] Server not found or not OAuth type');
      if (redirectUrl) {
        return popupRedirect(openerBase, { oauth: 'error', message: 'server_not_found' });
      }
      return new NextResponse('Server configuration not found', { status: 404 });
    }

    // Decrypt OAuth config to get client credentials and token endpoint
    let oauthConfig: OAuthConfig;
    try {
      const decrypted = decryptApiKey(server.authConfig!);
      oauthConfig = JSON.parse(decrypted) as OAuthConfig;
    } catch {
      console.error('[OAuthCallback] Failed to decrypt OAuth config');
      if (redirectUrl) {
        return popupRedirect(openerBase, { oauth: 'error', message: 'config_decrypt_failed' });
      }
      return new NextResponse('Failed to decrypt OAuth configuration', { status: 500 });
    }

    if (!oauthConfig.clientId || !oauthConfig.tokenUrl) {
      console.error('[OAuthCallback] Missing required OAuth config fields');
      if (redirectUrl) {
        return popupRedirect(openerBase, { oauth: 'error', message: 'missing_oauth_config' });
      }
      return new NextResponse('OAuth configuration missing required fields (clientId, tokenUrl)', { status: 400 });
    }

    // Validate tokenUrl is a proper, absolute URL
    let parsedTokenUrl: URL;
    try {
      parsedTokenUrl = new URL(oauthConfig.tokenUrl);
    } catch {
      console.error('[OAuthCallback] Invalid tokenUrl in authConfig:', oauthConfig.tokenUrl);
      if (redirectUrl) {
        return popupRedirect(openerBase, { oauth: 'error', message: 'invalid_token_url' });
      }
      return new NextResponse('Invalid tokenUrl in authConfig — must be a valid, absolute URL', { status: 400 });
    }

    // SSRF protection: reject tokenUrl pointing to internal/private hosts
    if (!isExternalUrl(parsedTokenUrl)) {
      console.error('[OAuthCallback] SSRF blocked — tokenUrl resolves to an internal/private address:', oauthConfig.tokenUrl);
      if (redirectUrl) {
        return popupRedirect(openerBase, { oauth: 'error', message: 'ssrf_blocked' });
      }
      return new NextResponse('Token exchange target is an internal/private address — SSRF blocked', { status: 400 });
    }

    // Exchange authorization code for tokens at the provider's token endpoint.
    // Use the redirectUri from the state token — it matches the one used in the
    // authorization request, which is required by RFC 6749 §4.1.3.
    // with state tokens created before redirectUri was stored.
    const tokenExchangeRedirectUri = redirectUri || `${adminBase}/api/oauth/mcp-callback`;
    const tokenResponse = await exchangeCodeForTokens(
      oauthConfig.tokenUrl,
      code,
      oauthConfig.clientId,
      oauthConfig.clientSecret ?? null,
      tokenExchangeRedirectUri,
      codeVerifier
    );

    if (!tokenResponse) {
      console.error('[OAuthCallback] Token exchange failed');
      if (redirectUrl) {
        return popupRedirect(openerBase, { oauth: 'error', message: 'token_exchange_failed' });
      }
      return new NextResponse('Token exchange failed', { status: 502 });
    }

    // Build updated OAuth config with tokens (preserve provider endpoints)
    const updatedOAuthConfig: OAuthConfig = {
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      scopes: oauthConfig.scopes || '',
      authorizeUrl: oauthConfig.authorizeUrl,
      tokenUrl: oauthConfig.tokenUrl,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || undefined,
      expiresAt: tokenResponse.expires_in ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in : undefined,
    };

    // Encrypt and save
    const encryptedConfig = encryptApiKey(JSON.stringify(updatedOAuthConfig));

    await prisma.botMcpServer.update({
      where: { id: serverId },
      data: { authConfig: encryptedConfig },
    });

    console.log(`[OAuthCallback] Tokens stored for server ${serverId} (bot ${botId})`);

    // Redirect to the popup callback page on the opener's origin.
    // This ensures the popup navigates to the same origin as the page that
    // opened it (universe.bawes.net or orbit.bawes.net), so postMessage
    // and window.close() work reliably.
    return popupRedirect(openerBase, { oauth: 'success' });
  } catch (error) {
    console.error('[OAuthCallback] Error:', error);
    return new NextResponse('Internal server error', { status: 500 });
  }
}

/**
 * Parse the encrypted state token.
 * Checks the `exp` claim (epoch seconds) and returns null if expired.
 */
function parseStateToken(state: string | null): { botId: string; serverId: string; redirectUrl: string; codeVerifier?: string; redirectUri?: string } | null {
  if (!state) return null;
  try {
    const decrypted = decryptApiKey(state);
    const parsed = JSON.parse(decrypted);
    // Enforce state token freshness — reject if expired
    if (parsed.exp && Date.now() > parsed.exp * 1000) {
      console.error('[OAuthCallback] State token expired');
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Exchange an authorization code for tokens at the provider's token endpoint.
 */
async function exchangeCodeForTokens(
  tokenEndpoint: string,
  code: string,
  clientId: string,
  clientSecret: string | null,
  redirectUri: string,
  codeVerifier?: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number } | null> {
  try {
    const body = new URLSearchParams();
    body.set('grant_type', 'authorization_code');
    body.set('code', code);
    body.set('client_id', clientId);
    // clientSecret is optional — public OAuth clients (PKCE) have no secret
    // Only send it if present; omitting it signals a public client per RFC 6749 §2.1
    if (clientSecret != null) {
      body.set('client_secret', clientSecret);
    }
    body.set('redirect_uri', redirectUri);
    if (codeVerifier) {
      body.set('code_verifier', codeVerifier);
    }

    const response = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: body.toString(),
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.error(`[OAuthCallback] Token exchange HTTP ${response.status}: ${errorText}`);
      return null;
    }

    const data = await response.json();

    if (data.error) {
      console.error(`[OAuthCallback] Token exchange error: ${data.error} — ${data.error_description || ''}`);
      return null;
    }

    if (!data.access_token) {
      console.error('[OAuthCallback] Token exchange response missing access_token');
      return null;
    }

    return {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: data.expires_in,
    };
  } catch (error) {
    console.error('[OAuthCallback] Token exchange fetch failed:', error);
    return null;
  }
}

/**
 * SSRF protection: check that a URL host is an external (public) hostname,
 * not an internal/private/reserved address.
 *
 * This performs a string/hostname-based check only — no DNS resolution is
 * required. It blocks:
 *   - Private IPv4 ranges (10.x.x.x, 172.16-31.x.x, 192.168.x.x)
 *   - Localhost / loopback (127.x.x.x, ::1, 'localhost', '127.0.0.1')
 *   - Link-local / APIPA (169.254.x.x)
 *   - Cloud metadata IP (169.254.169.254)
 *   - Hostnames without a dot (e.g. 'http://internal/')
 *   - IPv6 link-local and unique-local addresses
 *
 * Returns true if the host is safe to call (external), false if it looks internal.
 */
function isExternalUrl(url: URL): boolean {
  const hostname = url.hostname.toLowerCase();

  // Block bare hostnames (no dots) — likely internal service names
  // e.g. http://internal-service/, http://metadata/, http://localhost/
  // Exception: allow 'localhost' explicitly handled below by IP checks
  if (!hostname.includes('.')) {
    // Allow single-label hostnames that are IP addresses (they'll be caught below)
    const isIpLike = /^[0-9a-f:.]+$/.test(hostname);
    if (!isIpLike) {
      return false;
    }
  }

  // Block localhost and loopback
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
    return false;
  }

  // Block IPv4 private and reserved ranges
  const ipv4Match = hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const parts = ipv4Match.slice(1).map(Number);
    // 10.x.x.x
    if (parts[0] === 10) return false;
    // 172.16.0.0 – 172.31.255.255
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
    // 192.168.x.x
    if (parts[0] === 192 && parts[1] === 168) return false;
    // 127.x.x.x (loopback)
    if (parts[0] === 127) return false;
    // 169.254.x.x (link-local / APIPA, includes metadata IP 169.254.169.254)
    if (parts[0] === 169 && parts[1] === 254) return false;
    // 0.x.x.x
    if (parts[0] === 0) return false;
  }

  // Block IPv6 loopback and unique-local (fc00::/7, fd00::/7)
  if (hostname.startsWith('fc') || hostname.startsWith('fd')) {
    return false;
  }
  if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') {
    return false;
  }

  return true;
}
