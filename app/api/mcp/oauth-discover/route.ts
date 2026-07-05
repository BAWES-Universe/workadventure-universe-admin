import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Block requests to private/internal networks (mirrors isAllowedServerUrl from MCP routes)
function isExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    let hostname = parsed.hostname.toLowerCase();
    // Strip brackets from IPv6 literals (new URL('http://[::1]').hostname returns '[::1]')
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }
    if (hostname === 'localhost' || hostname === '::1') return false;
    if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return false;         // 127.0.0.0/8 loopback
    if (/^0\.0\.0\.0$/.test(hostname)) return false;
    // Handle IPv4-mapped IPv6 addresses (::ffff:127.0.0.1, etc.)
    if (/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.test(hostname)) {
      const ipv4 = hostname.replace(/^::ffff:/i, '');
      if (ipv4 === '127.0.0.1' || /^127\.\d+\.\d+\.\d+$/.test(ipv4) || ipv4 === '0.0.0.0') return false;
      if (/^10\.\d+\.\d+\.\d+$/.test(ipv4) || /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ipv4)) return false;
      if (/^192\.168\.\d+\.\d+$/.test(ipv4) || /^169\.254\.\d+\.\d+$/.test(ipv4)) return false;
    }
    if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) return false;
    if (/^192\.168\.\d+\.\d+$/.test(hostname)) return false;
    if (/^169\.254\.\d+\.\d+$/.test(hostname)) return false;
    // Reject private IPv6 ranges (unique-local, link-local, unspecified)
    if (/^f[cd][0-9a-f]{0,3}:/i.test(hostname)) return false;
    if (/^fe[89a-b][0-9a-f]:/i.test(hostname)) return false;         // fe80::/10 link-local
    if (/^::$/.test(hostname)) return false;
    if (hostname === '169.254.169.254') return false;
    if (hostname === 'metadata.google.internal' || hostname === 'metadata.internal') return false;
    if (hostname.endsWith('.internal')) return false;
    if (hostname.endsWith('.local')) return false;
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
