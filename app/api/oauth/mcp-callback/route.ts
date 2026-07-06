import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';

export const runtime = 'nodejs';

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

    // Handle provider-level error (user denied, etc.)
    if (errorParam) {
      console.error('[OAuthCallback] Provider error:', errorParam);
      const errState = parseStateToken(state);
      const errorOrigin = errState?.redirectUrl || new URL(request.url).origin;
      return NextResponse.redirect(
        new URL('/api/oauth/error?message=' + encodeURIComponent(errorParam), errorOrigin)
      );
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

    // Load the MCP server config to get OAuth provider config
    const server = await prisma.botMcpServer.findUnique({
      where: { id: serverId },
      select: { id: true, botId: true, authType: true, authConfig: true },
    });

    if (!server || server.botId !== botId || server.authType !== 'oauth') {
      console.error('[OAuthCallback] Server not found or not OAuth type');
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL('/api/oauth/error?message=server_not_found', redirectUrl)
        );
      }
      return new NextResponse('Server configuration not found', { status: 404 });
    }

    // Decrypt OAuth config to get client credentials and token endpoint
    let oauthConfig: Record<string, any>;
    try {
      const decrypted = decryptApiKey(server.authConfig!);
      oauthConfig = JSON.parse(decrypted);
    } catch {
      console.error('[OAuthCallback] Failed to decrypt OAuth config');
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL('/api/oauth/error?message=config_decrypt_failed', redirectUrl)
        );
      }
      return new NextResponse('Failed to decrypt OAuth configuration', { status: 500 });
    }

    if (!oauthConfig.clientId || !oauthConfig.tokenUrl) {
      console.error('[OAuthCallback] Missing required OAuth config fields');
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL('/api/oauth/error?message=missing_oauth_config', redirectUrl)
        );
      }
      return new NextResponse('OAuth configuration missing required fields (clientId, tokenUrl)', { status: 400 });
    }

    // Validate tokenUrl before attempting exchange
    let parsedTokenUrl: URL;
    try {
      parsedTokenUrl = new URL(oauthConfig.tokenUrl);
    } catch {
      console.error('[OAuthCallback] Invalid tokenUrl in authConfig:', oauthConfig.tokenUrl);
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL('/api/oauth/error?message=invalid_token_url', redirectUrl)
        );
      }
      return new NextResponse('Invalid tokenUrl in authConfig — must be a valid, absolute URL', { status: 400 });
    }
    // SSRF protection: tokenUrl must point to an external address
    let hostname = parsedTokenUrl.hostname.toLowerCase();
    // Strip brackets from IPv6 literals (Node's URL parser returns '[::1]' for IPv6)
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }
    const isPrivate =
      hostname === 'localhost' ||
      hostname === '::1' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '169.254.169.254' ||
      hostname === 'metadata.google.internal' ||
      hostname.endsWith('.internal') ||
      hostname.endsWith('.local') ||
      /^127\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^10\.\d+\.\d+\.\d+$/.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname) ||
      /^192\.168\.\d+\.\d+$/.test(hostname) ||
      /^169\.254\.\d+\.\d+$/.test(hostname) ||
      /^::ffff:(127\.\d+\.\d+\.\d+|0\.0\.0\.0|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/i.test(hostname) ||
      /^f[cd][0-9a-f]{0,3}:/i.test(hostname) ||
      /^fe[89a-b][0-9a-f]:/i.test(hostname);
    if (isPrivate) {
      console.error('[OAuthCallback] Blocked tokenUrl pointing to internal address:', oauthConfig.tokenUrl);
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL('/api/oauth/error?message=invalid_token_url', redirectUrl)
        );
      }
      return new NextResponse('Token URL must be a public, external address', { status: 400 });
    }

    // Exchange authorization code for tokens at the provider's token endpoint.
    // Use the redirectUri from the state token — it matches the one used in the
    // authorization request, which is required by RFC 6749 §4.1.3.
    // Fall back to constructing from request.url.origin for backward compatibility
    // with state tokens created before redirectUri was stored.
    const callbackBase = process.env.ADMIN_API_URL || new URL(request.url).origin;
    const tokenExchangeRedirectUri = redirectUri || `${callbackBase}/api/oauth/mcp-callback`;
    const tokenResponse = await exchangeCodeForTokens(
      oauthConfig.tokenUrl,
      code,
      oauthConfig.clientId,
      oauthConfig.clientSecret,
      tokenExchangeRedirectUri,
      codeVerifier
    );

    if (!tokenResponse) {
      console.error('[OAuthCallback] Token exchange failed');
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL('/api/oauth/error?message=token_exchange_failed', redirectUrl)
        );
      }
      return new NextResponse('Token exchange failed', { status: 502 });
    }

    // Build updated OAuth config with tokens (preserve provider endpoints)
    const updatedOAuthConfig = {
      clientId: oauthConfig.clientId,
      clientSecret: oauthConfig.clientSecret,
      scopes: oauthConfig.scopes || '',
      authorizeUrl: oauthConfig.authorizeUrl,
      tokenUrl: oauthConfig.tokenUrl,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token || null,
      expiresAt: tokenResponse.expires_in ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in : null,
    };

    // Encrypt and save
    const encryptedConfig = encryptApiKey(JSON.stringify(updatedOAuthConfig));

    await prisma.botMcpServer.update({
      where: { id: serverId },
      data: { authConfig: encryptedConfig },
    });

    console.log(`[OAuthCallback] Tokens stored for server ${serverId} (bot ${botId})`);

    // Redirect to the success page instead of the game URL.
    // Use redirectUrl from the state token (which is always the correct external
    // origin — the user's browser URL at the time of OAuth start) rather than
    // request.url.origin, which resolves to an internal Docker hostname in
    // containerized environments. Resolving /api/oauth/success relative to
    // redirectUrl gives the correct absolute URL in both dev and prod.
    return NextResponse.redirect(
      new URL('/api/oauth/success', redirectUrl)
    );
  } catch (error) {
    console.error('[OAuthCallback] Error:', error);
    return new NextResponse('Internal server error', { status: 500 });
  }
}

/**
 * Parse the encrypted state token.
 */
function parseStateToken(state: string | null): { botId: string; serverId: string; redirectUrl: string; codeVerifier?: string; redirectUri?: string } | null {
  if (!state) return null;
  try {
    const decrypted = decryptApiKey(state);
    return JSON.parse(decrypted);
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
