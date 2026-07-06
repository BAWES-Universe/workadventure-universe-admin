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
      if (errState?.redirectUrl) {
        return NextResponse.redirect(
          new URL(errState.redirectUrl + (errState.redirectUrl.includes('?') ? '&' : '?') + 'oauth=error&message=' + encodeURIComponent(errorParam))
        );
      }
      return new NextResponse(`OAuth authorization failed: ${errorParam}`, { status: 400 });
    }

    if (!code || !state) {
      return new NextResponse('Missing code or state parameter', { status: 400 });
    }

    // Decrypt state to get botId, serverId, redirectUrl, codeVerifier
    const stateData = parseStateToken(state);
    if (!stateData) {
      return new NextResponse('Invalid state token', { status: 400 });
    }

    const { botId, serverId, redirectUrl, codeVerifier } = stateData;

    // Load the MCP server config to get OAuth provider config
    const server = await prisma.botMcpServer.findUnique({
      where: { id: serverId },
      select: { id: true, botId: true, authType: true, authConfig: true },
    });

    if (!server || server.botId !== botId || server.authType !== 'oauth') {
      console.error('[OAuthCallback] Server not found or not OAuth type');
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL(redirectUrl + (redirectUrl.includes('?') ? '&' : '?') + 'oauth=error&message=server_not_found')
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
          new URL(redirectUrl + (redirectUrl.includes('?') ? '&' : '?') + 'oauth=error&message=config_decrypt_failed')
        );
      }
      return new NextResponse('Failed to decrypt OAuth configuration', { status: 500 });
    }

    if (!oauthConfig.clientId || !oauthConfig.tokenUrl) {
      console.error('[OAuthCallback] Missing required OAuth config fields');
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL(redirectUrl + (redirectUrl.includes('?') ? '&' : '?') + 'oauth=error&message=missing_oauth_config')
        );
      }
      return new NextResponse('OAuth configuration missing required fields (clientId, tokenUrl)', { status: 400 });
    }

    // Validate tokenUrl before attempting exchange
    try {
      new URL(oauthConfig.tokenUrl);
    } catch {
      console.error('[OAuthCallback] Invalid tokenUrl in authConfig:', oauthConfig.tokenUrl);
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL(redirectUrl + (redirectUrl.includes('?') ? '&' : '?') + 'oauth=error&message=invalid_token_url')
        );
      }
      return new NextResponse('Invalid tokenUrl in authConfig — must be a valid, absolute URL', { status: 400 });
    }

    // Exchange authorization code for tokens at the provider's token endpoint
    const callbackBase = process.env.ADMIN_API_URL || new URL(request.url).origin;
    const tokenResponse = await exchangeCodeForTokens(
      oauthConfig.tokenUrl,
      code,
      oauthConfig.clientId,
      oauthConfig.clientSecret,
      `${callbackBase}/api/oauth/mcp-callback`,
      codeVerifier
    );

    if (!tokenResponse) {
      console.error('[OAuthCallback] Token exchange failed');
      if (redirectUrl) {
        return NextResponse.redirect(
          new URL(redirectUrl + (redirectUrl.includes('?') ? '&' : '?') + 'oauth=error&message=token_exchange_failed')
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
function parseStateToken(state: string | null): { botId: string; serverId: string; redirectUrl: string; codeVerifier?: string } | null {
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
    if (clientSecret !== null) {
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
