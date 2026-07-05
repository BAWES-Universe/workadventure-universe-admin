import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

/**
 * GET /api/mcp/oauth-discover?serverUrl=<encoded>&callbackUrl=<encoded>
 *
 * Discovers OAuth endpoints for an MCP server using the standard
 * MCP OAuth authorization flow (RFC 8414).
 *
 * Steps:
 *   1. Fetch /.well-known/oauth-authorization-server from the server's base URL
 *   2. If found and a registration endpoint is available, attempt dynamic
 *      client registration (RFC 7591) to obtain client_id and client_secret
 *   3. Return discovery results
 */
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const serverUrl = searchParams.get('serverUrl');
    const callbackUrl = searchParams.get('callbackUrl');

    if (!serverUrl) {
      return NextResponse.json(
        { error: 'serverUrl query parameter is required' },
        { status: 400 }
      );
    }

    // Parse server URL to get base (origin without path)
    let parsedServerUrl: URL;
    try {
      parsedServerUrl = new URL(serverUrl);
    } catch {
      return NextResponse.json(
        { error: 'Invalid serverUrl — must be a valid URL' },
        { status: 400 }
      );
    }

    const baseUrl = `${parsedServerUrl.protocol}//${parsedServerUrl.host}`;

    // Step 1: Try metadata discovery
    const metadataUrl = `${baseUrl}/.well-known/oauth-authorization-server`;
    let metadata: Record<string, any> | null = null;

    try {
      const metadataResponse = await fetch(metadataUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (metadataResponse.ok) {
        metadata = await metadataResponse.json();
      }
    } catch {
      // Metadata not available — will use fallback
    }

    // If no metadata via well-known, try the MCP server root itself
    // Some servers return metadata on initial connect
    if (!metadata) {
      try {
        const serverResponse = await fetch(serverUrl, {
          method: 'GET',
          headers: {
            'MCP-Protocol-Version': '2024-11-05',
          },
          signal: AbortSignal.timeout(5000),
        });

        // Check WWW-Authenticate header for OAuth hints
        const authHeader = serverResponse.headers.get('WWW-Authenticate');
        if (authHeader && authHeader.toLowerCase().includes('bearer')) {
          // The server wants auth but didn't provide metadata endpoint — try fallback paths
          const fallbackUrl = `${baseUrl}/.well-known/oauth-authorization-server`;
          const fallbackResponse = await fetch(fallbackUrl, {
            signal: AbortSignal.timeout(5000),
          });
          if (fallbackResponse.ok) {
            metadata = await fallbackResponse.json();
          }
        }
      } catch {
        // Server not reachable or timed out
      }
    }

    if (!metadata) {
      return NextResponse.json({
        discovered: false,
      });
    }

    const authorizeUrl = metadata.authorization_endpoint || `${baseUrl}/authorize`;
    const tokenUrl = metadata.token_endpoint || `${baseUrl}/token`;
    const registrationEndpoint = metadata.registration_endpoint || null;
    const scopesSupported = metadata.scopes_supported || null;

    // Step 2: Try dynamic client registration
    let clientId: string | null = null;
    let clientSecret: string | null = null;

    if (registrationEndpoint && callbackUrl) {
      try {
        const registrationResponse = await fetch(registrationEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_name: 'Hermes Agent Bot',
            redirect_uris: [callbackUrl],
            token_endpoint_auth_method: 'client_secret_basic',
            grant_types: ['authorization_code'],
            response_types: ['code'],
          }),
          signal: AbortSignal.timeout(10000),
        });

        if (registrationResponse.ok) {
          const registration = await registrationResponse.json();
          clientId = registration.client_id || null;
          clientSecret = registration.client_secret || null;
        }
      } catch {
        // Registration failed — user will provide credentials manually
      }
    }

    return NextResponse.json({
      discovered: true,
      authorizeUrl,
      tokenUrl,
      registrationEndpoint,
      scopesSupported,
      clientId,
      clientSecret,
    });
  } catch (error) {
    console.error('[OAuthDiscover] Error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
