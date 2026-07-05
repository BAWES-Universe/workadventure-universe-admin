import { NextRequest, NextResponse } from 'next/server';
import { isIP } from 'net';

export const runtime = 'nodejs';

// Block requests to private/internal networks
function isExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    const hostname = parsed.hostname.toLowerCase();
    // Block localhost
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1') return false;
    // Block private IP ranges
    if (isIP(hostname)) {
      const parts = hostname.split('.').map(Number);
      if (parts[0] === 10) return false;
      if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return false;
      if (parts[0] === 192 && parts[1] === 168) return false;
      if (parts[0] === 169 && parts[1] === 254) return false; // link-local / metadata
    }
    // Block hostnames ending with internal TLDs
    if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
    return true;
  } catch {
    return false;
  }
}

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

    // SSRF protection: reject requests to internal/private networks
    if (!isExternalUrl(serverUrl)) {
      return NextResponse.json(
        { error: 'Server URL must point to a public, external address' },
        { status: 400 }
      );
    }

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
      // SSRF protection: registration endpoint must belong to the same origin
      let parsedRegistration: URL;
      try {
        parsedRegistration = new URL(registrationEndpoint);
      } catch {
        return NextResponse.json({
          discovered: true,
          authorizeUrl,
          tokenUrl,
          registrationEndpoint: null,
          scopesSupported,
          clientId: null,
          clientSecret: null,
        });
      }
      if (parsedRegistration.origin !== parsedServerUrl.origin) {
        // Registration is on a different origin — skip auto-registration
        return NextResponse.json({
          discovered: true,
          authorizeUrl,
          tokenUrl,
          registrationEndpoint: null,
          scopesSupported,
          clientId: null,
          clientSecret: null,
        });
      }
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
