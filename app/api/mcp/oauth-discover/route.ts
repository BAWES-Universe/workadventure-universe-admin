import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

// Block requests to private/internal networks (mirrors isAllowedServerUrl from MCP routes)
function isExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    let hostname = parsed.hostname.toLowerCase();
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }
    if (hostname === 'localhost' || hostname === '::1') return false;
    if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return false;
    if (/^0\.0\.0\.0$/.test(hostname)) return false;
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
    if (/^f[cd][0-9a-f]{0,3}:/i.test(hostname)) return false;
    if (/^fe[89a-b][0-9a-f]:/i.test(hostname)) return false;
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
 * Extract OAuth metadata from a 401 response body or WWW-Authenticate header.
 * Looks for authorization_endpoint / authorizationUrl, token_endpoint / tokenUrl,
 * registration_endpoint, and scopes_supported.
 */
function extractOAuthMetadata(body: any): Record<string, any> | null {
  if (!body || typeof body !== 'object') return null;

  // JSON-RPC error format: { error: { code, message, data: { authorizationUrl, ... } } }
  const errorData = body.error?.data || body.error || body;

  const authorizeUrl =
    errorData.authorization_endpoint ||
    errorData.authorizationUrl ||
    errorData.authorization_url ||
    errorData.authorizeUrl ||
    errorData.authorize_url ||
    null;

  const tokenUrl =
    errorData.token_endpoint ||
    errorData.tokenUrl ||
    errorData.token_url ||
    null;

  if (!authorizeUrl || !tokenUrl) return null;

  return {
    authorization_endpoint: authorizeUrl,
    token_endpoint: tokenUrl,
    registration_endpoint: errorData.registration_endpoint || errorData.registrationEndpoint || null,
    scopes_supported: errorData.scopes_supported || null,
  };
}

/**
 * GET /api/mcp/oauth-discover?serverUrl=<encoded>&callbackUrl=<encoded>
 *
 * Discovers OAuth endpoints for an MCP server using the standard
 * MCP OAuth authorization flow.
 *
 * Flow:
 *   1. POST to the MCP server with a JSON-RPC initialize request.
 *      On 401, parse the response body for OAuth metadata.
 *   2. If the 401 body has no OAuth metadata, check WWW-Authenticate header
 *      and try .well-known fallback.
 *   3. If registration endpoint found, dynamically register to get
 *      client credentials.
 *   4. Return discovery results with registrationStatus flag.
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

    // Parse server URL
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

    // SSRF protection
    if (!isExternalUrl(serverUrl)) {
      return NextResponse.json(
        { error: 'Server URL must point to a public, external address' },
        { status: 400 }
      );
    }

    // Step 1: Connect to the MCP server with a JSON-RPC initialize request.
    // If the server returns 401, the body should contain OAuth metadata.
    let metadata: Record<string, any> | null = null;

    try {
      const mcpResponse = await fetch(serverUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2024-11-05',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'hermes-agent', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(8000),
      });

      if (mcpResponse.status === 401) {
        // Try to parse the 401 body for OAuth metadata
        try {
          const body = await mcpResponse.json();
          metadata = extractOAuthMetadata(body);
        } catch {
          // Body wasn't JSON — check headers
        }

        // Fallback: check WWW-Authenticate header
        if (!metadata) {
          const authHeader = mcpResponse.headers.get('WWW-Authenticate');
          if (authHeader) {
            // Some servers put the metadata endpoint URL in WWW-Authenticate
            const realmMatch = authHeader.match(/realm="([^"]+)"/);
            if (realmMatch) {
              const metadataUrl = `${realmMatch[1].replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
              try {
                const wkResponse = await fetch(metadataUrl, { signal: AbortSignal.timeout(5000) });
                if (wkResponse.ok) metadata = await wkResponse.json();
              } catch { /* ignore */ }
            }
          }
        }
      }
    } catch {
      // Server not reachable — will try .well-known fallback
    }

    // Step 2: Fallback — try .well-known/oauth-authorization-server
    if (!metadata) {
      try {
        const metadataUrl = `${baseUrl}/.well-known/oauth-authorization-server`;
        const metadataResponse = await fetch(metadataUrl, {
          signal: AbortSignal.timeout(5000),
        });
        if (metadataResponse.ok) {
          metadata = await metadataResponse.json();
        }
      } catch {
        // Not available
      }
    }

    if (!metadata) {
      return NextResponse.json({ discovered: false });
    }

    const authorizeUrl = metadata.authorization_endpoint || `${baseUrl}/authorize`;
    const tokenUrl = metadata.token_endpoint || `${baseUrl}/token`;
    const registrationEndpoint = metadata.registration_endpoint || null;
    const scopesSupported = metadata.scopes_supported || null;

    // Step 3: Try dynamic client registration
    let clientId: string | null = null;
    let clientSecret: string | null = null;
    let registered = false;

    if (registrationEndpoint && callbackUrl) {
      // SSRF protection: registration endpoint must belong to the same origin
      try {
        const parsedRegistration = new URL(registrationEndpoint);
        if (parsedRegistration.origin === parsedServerUrl.origin) {
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
            registered = !!(clientId && clientSecret);
          }
        }
      } catch {
        // Registration failed — manual credentials required
      }
    }

    return NextResponse.json({
      discovered: true,
      authorizeUrl,
      tokenUrl,
      scopesSupported,
      clientId,
      clientSecret,
      registrationStatus: registered ? 'auto' : 'manual',
    });
  } catch (error) {
    console.error('[OAuthDiscover] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
