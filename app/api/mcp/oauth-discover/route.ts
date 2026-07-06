import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';

export const runtime = 'nodejs';

// CORS headers
function corsHeaders(request?: NextRequest) {
  const origin = request?.headers?.get('origin');
  if (!origin) {
    return {
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }
  const trustedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
  if (trustedOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
  }
  return headers;
}

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

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
    token_endpoint_auth_methods_supported: errorData.token_endpoint_auth_methods_supported || null,
  };
}

/**
 * Parse a WWW-Authenticate header to extract OAuth metadata URLs.
 * Handles both `realm` and `resource_metadata` (RFC 9728) parameter formats.
 * Returns the URL to fetch for OAuth authorization server metadata, or null.
 */
function parseWwwAuthenticate(header: string): string | null {
  // Try resource_metadata first (RFC 9728 — protected resource metadata)
  const resourceMatch = header.match(/resource_metadata="([^"]+)"/);
  if (resourceMatch) {
    return resourceMatch[1];
  }

  // Fallback to realm (traditional OAuth)
  const realmMatch = header.match(/realm="([^"]+)"/);
  if (realmMatch) {
    const realm = realmMatch[1].replace(/\/$/, '');
    return `${realm}/.well-known/oauth-authorization-server`;
  }

  return null;
}

/**
 * Fetch OAuth authorization server metadata from a URL.
 * Returns the metadata if it contains authorization_endpoint or token_endpoint.
 * If the response is RFC 9728 protected resource metadata (has authorization_servers
 * but no OAuth endpoints), follows the chain to each server's well-known endpoint.
 */
async function fetchOAuthMetadata(url: string, signal: AbortSignal): Promise<Record<string, any> | null> {
  try {
    const response = await fetch(url, { signal });
    if (response.ok) {
      const metadata = await response.json();
      // Direct hit: has OAuth authorization server endpoints
      if (metadata.authorization_endpoint || metadata.token_endpoint) {
        return metadata;
      }
      // RFC 9728 protected resource metadata: follow authorization_servers chain
      if (metadata.authorization_servers && Array.isArray(metadata.authorization_servers)) {
        for (const server of metadata.authorization_servers) {
          try {
            const asUrl = `${server.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
            const asResponse = await fetch(asUrl, { signal: AbortSignal.timeout(5000) });
            if (asResponse.ok) {
              const asMetadata = await asResponse.json();
              if (asMetadata.authorization_endpoint || asMetadata.token_endpoint) {
                return asMetadata;
              }
            }
          } catch {
            // Try next authorization server
          }
        }
      }
    }
  } catch {
    // Not available
  }
  return null;
}

/**
 * Map token_endpoint_auth_method to the value used in the registration request body.
 * The spec says supported methods include: none, client_secret_basic, client_secret_post,
 * private_key_jwt, etc.
 */
function getPreferredAuthMethod(supported: string[] | null): string {
  if (!supported || supported.length === 0) return 'client_secret_basic';
  if (supported.includes('none')) return 'none';
  if (supported.includes('client_secret_post')) return 'client_secret_post';
  if (supported.includes('client_secret_basic')) return 'client_secret_basic';
  return supported[0];
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
 *      client credentials (supports cross-origin registration endpoints
 *      from well-known metadata).
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
        { status: 400, headers: corsHeaders(request) }
      );
    }

    // Parse server URL
    let parsedServerUrl: URL;
    try {
      parsedServerUrl = new URL(serverUrl);
    } catch {
      return NextResponse.json(
        { error: 'Invalid serverUrl — must be a valid URL' },
        { status: 400, headers: corsHeaders(request) }
      );
    }

    const baseUrl = `${parsedServerUrl.protocol}//${parsedServerUrl.host}`;

    // SSRF protection
    if (!isExternalUrl(serverUrl)) {
      return NextResponse.json(
        { error: 'Server URL must point to a public, external address' },
        { status: 400, headers: corsHeaders(request) }
      );
    }

    // Authenticate: require a valid session user or admin API token
    const sessionUser = await getSessionUser(request);
    let isAuthenticated = false;

    if (sessionUser) {
      isAuthenticated = true;
    } else {
      // Check for admin API token (Bearer header)
      const authHeader = request.headers.get('authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.replace('Bearer ', '').trim();
        if (token === process.env.ADMIN_API_TOKEN) {
          isAuthenticated = true;
        }
      }
      // Also check for session token query param (used by play server's BotApiService)
      if (!isAuthenticated) {
        const tokenParam = searchParams.get('_token');
        if (tokenParam) {
          // Validate the session token via getSessionUser with the token as a query param hint
          // The token is already present in the URL, so try re-authentication
          const retryUrl = new URL(request.url);
          retryUrl.searchParams.set('_token', tokenParam);
          const retryRequest = new NextRequest(retryUrl, request);
          const retryUser = await getSessionUser(retryRequest);
          if (retryUser) {
            isAuthenticated = true;
          }
        }
      }
    }

    if (!isAuthenticated) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders(request) }
      );
    }

    // Track where metadata was sourced — well-known metadata is self-authenticating
    // and its registration endpoints can be cross-origin from the MCP server
    let metadata: Record<string, any> | null = null;
    let metadataSource: 'mcp_401' | 'well_known' | null = null;

    // Step 1: Connect to the MCP server with a JSON-RPC initialize request.
    // If the server returns 401, the body or headers may contain OAuth metadata.
    let wwwAuthenticateHeader: string | null = null;

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

      // Save WWW-Authenticate header regardless of how we got here
      wwwAuthenticateHeader = mcpResponse.headers.get('WWW-Authenticate');

      if (mcpResponse.status === 401) {
        // Try to parse the 401 body for OAuth metadata
        try {
          const body = await mcpResponse.json();
          metadata = extractOAuthMetadata(body);
          if (metadata) metadataSource = 'mcp_401';
        } catch {
          // Body wasn't JSON — check headers
        }
      }
    } catch {
      // Server not reachable — try well-known fallback
    }

    // Step 2: If the 401 body had no OAuth metadata, check WWW-Authenticate header.
    // Parse both realm and resource_metadata (RFC 9728) formats.
    if (!metadata && wwwAuthenticateHeader) {
      const metadataUrl = parseWwwAuthenticate(wwwAuthenticateHeader);
      if (metadataUrl) {
        metadata = await fetchOAuthMetadata(metadataUrl, AbortSignal.timeout(5000));
        if (metadata) metadataSource = 'well_known';
      }
    }

    // Step 3: Fallback — try baseUrl/.well-known/oauth-authorization-server
    if (!metadata) {
      const metadataUrl = `${baseUrl}/.well-known/oauth-authorization-server`;
      metadata = await fetchOAuthMetadata(metadataUrl, AbortSignal.timeout(5000));
      if (metadata) metadataSource = 'well_known';
    }

    if (!metadata) {
      return NextResponse.json({ discovered: false }, { headers: corsHeaders(request) });
    }

    const authorizeUrl = metadata.authorization_endpoint || `${baseUrl}/authorize`;
    const tokenUrl = metadata.token_endpoint || `${baseUrl}/token`;
    const registrationEndpoint = metadata.registration_endpoint || null;
    const scopesSupported = metadata.scopes_supported || null;
    const authMethodsSupported = metadata.token_endpoint_auth_methods_supported || null;

    // Step 4: Try dynamic client registration
    let clientId: string | null = null;
    let clientSecret: string | null = null;
    let registered = false;
    let registeredAuthMethod: string | null = null;

    if (registrationEndpoint && callbackUrl) {
      // SSRF protection for registration endpoint:
      // - Metadata from well-known is self-authenticating (served via HTTPS from the server's domain)
      // - Metadata from 401 body must match the MCP server origin
      let registrationAllowed = false;
      try {
        const parsedRegistration = new URL(registrationEndpoint);
        if (metadataSource === 'well_known') {
          // Trust registration endpoints from well-known metadata
          // The Authorization Server may be on a different origin than the MCP server
          // (e.g., Attio: MCP at mcp.attio.com, AS at app.attio.com)
          registrationAllowed = true;
        } else {
          // For 401 body metadata, require same origin
          registrationAllowed = parsedRegistration.origin === parsedServerUrl.origin;
        }
      } catch {
        registrationAllowed = false;
      }

      if (registrationAllowed) {
        try {
          const preferredAuthMethod = getPreferredAuthMethod(authMethodsSupported);

          const registrationBody: Record<string, any> = {
            client_name: 'Hermes Agent Bot',
            redirect_uris: [callbackUrl],
            grant_types: ['authorization_code'],
            response_types: ['code'],
          };

          // For "none" auth method, don't include token_endpoint_auth_method
          // (omitting it is equivalent). For other methods, set it explicitly.
          if (preferredAuthMethod !== 'none') {
            registrationBody.token_endpoint_auth_method = preferredAuthMethod;
          }

          const registrationResponse = await fetch(registrationEndpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(registrationBody),
            signal: AbortSignal.timeout(10000),
          });

          if (registrationResponse.ok) {
            const registration = await registrationResponse.json();
            clientId = registration.client_id || null;
            clientSecret = registration.client_secret || null;
            registered = !!(clientId);
            registeredAuthMethod = preferredAuthMethod;
          }
        } catch {
          // Registration failed — manual credentials required
        }
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
      // Indicate whether the registered client has a secret (for UX — hide client_secret field if "none")
      registeredAuthMethod,
    }, { headers: corsHeaders(request) });
  } catch (error) {
    console.error('[OAuthDiscover] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
  }
}
