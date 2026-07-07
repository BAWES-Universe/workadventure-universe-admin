import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { resolve4, resolve6 } from 'node:dns/promises';

export const runtime = 'nodejs';

/**
 * GET /api/mcp/oauth-discover
 *
 * Auto-discover OAuth authorization, token, and token introspection endpoints
 * from an MCP server that advertises them via OAuth 2.0 Dynamic Client Registration
 * Protocol — but ONLY discovers endpoints, does NOT register a client.
 *
 * The caller provides the MCP server URL, and this endpoint:
 * 1. Fetches the server's .well-known/mcp-config.json (SSRF-protected via safeFetch).
 * 2. Returns the OAuth metadata it finds, along with a registrationStatus
 *    ('auto' or 'manual') that tells the frontend whether the provider supports
 *    dynamic registration or only static/manual credentials.
 *
 * Registration itself happens later via the OAuth start endpoint
 * (POST /api/bots/[id]/mcp-servers/[serverId]/oauth/start), only when the
 * user clicks "Connect OAuth".
 *
 * NEVER stores secrets in this endpoint — it is read-only discovery.
 */

// ---------------------------------------------------------------------------
// Validation schema
// ---------------------------------------------------------------------------

const querySchema = z.object({
  url: z
    .string()
    .url('serverUrl must be a valid URL')
    .refine((url) => /^https?:\/\//i.test(url), {
      message: 'Only http and https URLs are supported',
    }),
  callbackUrl: z.string().url('callbackUrl must be a valid URL').optional(),
});

// ---------------------------------------------------------------------------
// SSRF protection helpers
// ---------------------------------------------------------------------------

/** Return true when `ip` belongs to a private / reserved range. */
function isPrivateIp(ip: string): boolean {
  if (/^127\.\d+\.\d+\.\d+$/.test(ip)) return true;
  if (/^0\.0\.0\.0$/.test(ip)) return true;
  if (ip === '::1') return true;                      // Loopback
  if (/^10\.\d+\.\d+\.\d+$/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(ip)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(ip)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(ip)) return true;
  if (ip === '169.254.169.254') return true;
  if (/^f[cd][0-9a-f]{0,3}:/i.test(ip)) return true; // Unique-local / site-local IPv6
  if (/^fe[89a-b][0-9a-f]:/i.test(ip)) return true;  // Link-local IPv6
  if (/^::$/.test(ip)) return true;                    // Unspecified
  return false;
}

/**
 * Block requests to private / internal networks.
 * Checks literal hostnames/IPs first, then resolves the hostname via DNS
 * and checks every resolved address against private ranges.
 */
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
      if (isPrivateIp(ipv4)) return false;
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
 * Resolve a hostname via DNS and validate that none of the resolved addresses
 * are private / internal.  Returns true when safe (all resolved IPs are
 * external).  Returns true immediately for literal IPs (already checked by
 * caller).
 */
async function resolveIsExternal(hostname: string): Promise<boolean> {
  // Skip DNS for literal IP addresses — already validated by isExternalUrl.
  if (/^[\d.]+$/.test(hostname) || /^[0-9a-f:]+$/i.test(hostname) || hostname.startsWith('[')) {
    return true;
  }
  let safe = true;
  // Check IPv4
  try {
    const v4 = await resolve4(hostname);
    if (v4.some(isPrivateIp)) safe = false;
  } catch {
    // No A record — not a problem
  }
  // Check IPv6
  try {
    const v6 = await resolve6(hostname);
    if (v6.some(isPrivateIp)) safe = false;
  } catch {
    // No AAAA record — not a problem
  }
  return safe;
}

/** Fetch wrapper that enforces SSRF and timeouts. */
async function safeFetch(
  url: string,
  options: RequestInit = {},
  timeoutMs = 5000
): Promise<Response> {
  if (!isExternalUrl(url)) {
    throw new Error('Blocked: URL points to a private or internal address');
  }
  // Double-check via DNS resolution
  const isExternal = await resolveIsExternal(new URL(url).hostname);
  if (!isExternal) {
    throw new Error('Blocked: DNS resolves to a private or internal address');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------------------------------------------------------------------
// MCP server config discovery
// ---------------------------------------------------------------------------

const MCP_ENDPOINTS = [
  '/.well-known/mcp.json',
  '/mcp.json',
] as const;

interface McpServerConfig {
  name?: string;
  description?: string;
  auth?: {
    type: string;
    // OAuth 2.0 Dynamic Client Registration
    registrationUrl?: string;
    clientRegistrationUrl?: string;
    // OAuth endpoints (RFC 8414 / OIDC Discovery)
    authorizationUrl?: string;
    tokenUrl?: string;
    tokenIntrospectionUrl?: string;
    // PKCE support
    codeChallengeMethod?: string[];
    // Supported scopes
    scopesSupported?: string[];
    // Registration type for frontend
    registrationStatus: 'auto' | 'manual';
  };
}

async function discoverMcpConfig(serverUrl: string): Promise<McpServerConfig | null> {
  for (const endpoint of MCP_ENDPOINTS) {
    try {
      const url = `${serverUrl.replace(/\/+$/, '')}${endpoint}`;
      if (!isExternalUrl(url)) continue;
      const response = await safeFetch(url, {}, 3000);
      if (!response.ok) continue;
      const config: McpServerConfig = await response.json();
      if (config && config.auth) {
        return config;
      }
    } catch {
      continue;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

interface DiscoveredOAuthInfo {
  discovered: boolean;
  authorizeUrl?: string;
  tokenUrl?: string;
  tokenIntrospectionUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopesSupported?: string[];
  codeChallengeMethod?: string[];
  registrationStatus?: 'auto' | 'manual';
  registrationUrl?: string;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // Authenticate — only logged-in users or admin tokens can discover OAuth config
    const sessionUser = await getSessionUser(request);
    let isAdminToken = false;

    if (!sessionUser) {
      const authHeader = request.headers.get('authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.replace('Bearer ', '').trim();
        const expectedToken = process.env.ADMIN_API_TOKEN;
        if (expectedToken && token === expectedToken) {
          isAdminToken = true;
        }
      }
    }

    if (!sessionUser && !isAdminToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const rawUrl = searchParams.get('url');
    const rawCallbackUrl = searchParams.get('callbackUrl');

    const parsed = querySchema.safeParse({ url: rawUrl, callbackUrl: rawCallbackUrl });
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: 'Invalid input',
          details: parsed.error.issues.map((i) => ({
            path: i.path.join('.'),
            message: i.message,
          })),
        },
        { status: 400 }
      );
    }

    const { url: serverUrl } = parsed.data;

    // Discover OAuth config from MCP server
    const mcpConfig = await discoverMcpConfig(serverUrl);

    if (!mcpConfig || !mcpConfig.auth) {
      return NextResponse.json({
        discovered: false,
      } satisfies DiscoveredOAuthInfo);
    }

    const auth = mcpConfig.auth;

    // Determine registration status
    // 'auto' = provider supports dynamic client registration (has registration or client reg URL)
    // 'manual' = we have endpoints but no registration URL — user must provide static credentials
    const hasRegistrationUrl = !!(auth.registrationUrl || auth.clientRegistrationUrl);
    const hasEndpoints = !!(auth.authorizationUrl || auth.tokenUrl);
    const registrationStatus = hasRegistrationUrl && hasEndpoints ? 'auto' : 'manual';

    const result: DiscoveredOAuthInfo = {
      discovered: true,
      authorizeUrl: auth.authorizationUrl,
      tokenUrl: auth.tokenUrl,
      tokenIntrospectionUrl: auth.tokenIntrospectionUrl,
      scopesSupported: auth.scopesSupported,
      codeChallengeMethod: auth.codeChallengeMethod,
      registrationStatus,
      registrationUrl: auth.registrationUrl || auth.clientRegistrationUrl,
    };

    return NextResponse.json(result);
  } catch (error) {
    console.error('[OAuthDiscover] Error:', error);
    return NextResponse.json(
      { error: 'Failed to discover OAuth endpoints' },
      { status: 500 }
    );
  }
}
