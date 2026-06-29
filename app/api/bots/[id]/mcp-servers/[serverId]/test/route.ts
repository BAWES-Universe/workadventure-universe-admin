import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { decryptApiKey } from '@/lib/encryption';
import { lookup } from 'dns/promises';
import { isIP } from 'net';

export const runtime = 'nodejs';

// Reject MCP server URLs that point to internal infrastructure (SSRF prevention)
function isAllowedServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();

    // Strip brackets from IPv6 literals (new URL('http://[::1]').hostname returns '[::1]')
    const cleanHostname = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

    // Reject localhost variants
    if (cleanHostname === 'localhost' || cleanHostname === '127.0.0.1' || cleanHostname === '0.0.0.0' || cleanHostname === '::1') {
      return false;
    }

    // Reject private IP ranges
    if (/^10\.\d+\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (/^192\.168\.\d+\.\d+$/.test(cleanHostname)) return false;
    if (/^169\.254\.\d+\.\d+$/.test(cleanHostname)) return false;

    // Reject private IPv6 ranges (unique-local, link-local, loopback)
    if (/^f[cd][0-9a-f]{0,3}:/i.test(cleanHostname)) return false; // fc00::/7 unique-local
    if (/^fe80:/i.test(cleanHostname)) return false;                 // fe80::/10 link-local
    if (/^::$/.test(cleanHostname)) return false;                    // :: (unspecified)

    // Reject cloud metadata endpoints
    if (cleanHostname === '169.254.169.254') return false;
    if (cleanHostname === 'metadata.google.internal' || cleanHostname === 'metadata.internal') return false;
    if (cleanHostname.endsWith('.internal')) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a hostname to its IP addresses and verify none are private.
 * Catches DNS-based SSRF bypasses (domain → private IP).
 */
async function isAllowedServerIp(serverUrl: string): Promise<{ allowed: boolean; error?: string }> {
  try {
    const parsed = new URL(serverUrl);
    let hostname = parsed.hostname.toLowerCase();
    // Strip brackets from IPv6 literals (new URL('http://[::1]').hostname returns '[::1]')
    if (hostname.startsWith('[') && hostname.endsWith(']')) {
      hostname = hostname.slice(1, -1);
    }

    // Check IP literal hostnames directly (the hostname-pattern check above cannot
    // catch all private IPv6 ranges, so we must check them here too)
    if (isIP(hostname)) {
      if (hostname === '::1' || hostname === '0.0.0.0' || hostname === '127.0.0.1') {
        return { allowed: false, error: `Server uses loopback address (${hostname})` };
      }
      if (/^10\./.test(hostname) || /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
          /^192\.168\./.test(hostname) || /^169\.254\./.test(hostname)) {
        return { allowed: false, error: `Server uses private IP address (${hostname})` };
      }
      if (/^f[cd][0-9a-f]{0,3}:/i.test(hostname)) {
        return { allowed: false, error: 'Server uses unique-local IPv6 address (fc00::/7)' };
      }
      if (/^fe80:/i.test(hostname)) {
        return { allowed: false, error: 'Server uses link-local IPv6 address (fe80::/10)' };
      }
      // IP literal that passed all checks — still resolve it to catch CNAME-based bypasses
    }

    const addresses = await lookup(hostname, { all: true });
    for (const addr of addresses) {
      const ip = addr.address;
      // Reject private and loopback ranges
      if (ip === '127.0.0.1' || ip === '::1' || ip === '0.0.0.0') {
        return { allowed: false, error: `Server resolves to loopback address (${ip})` };
      }
      if (/^10\./.test(ip)) {
        return { allowed: false, error: `Server resolves to private IP range (10.x.x.x)` };
      }
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) {
        return { allowed: false, error: `Server resolves to private IP range (172.16-31.x.x)` };
      }
      if (/^192\.168\./.test(ip)) {
        return { allowed: false, error: `Server resolves to private IP range (192.168.x.x)` };
      }
      if (/^169\.254\./.test(ip)) {
        return { allowed: false, error: `Server resolves to link-local address (169.254.x.x)` };
      }
      if (addr.family === 6) {
        // IPv6 private ranges
        if (/^fe80:/i.test(ip)) return { allowed: false, error: 'Server resolves to link-local IPv6 address (fe80:)' };
        if (/^f[cd][0-9a-f]{0,3}:/i.test(ip)) return { allowed: false, error: 'Server resolves to unique-local IPv6 address (fc00::/7)' };
        if (ip === '::1') return { allowed: false, error: 'Server resolves to IPv6 loopback' };
      }
    }
    return { allowed: true };
  } catch (dnsError: any) {
    return { allowed: false, error: `DNS resolution failed: ${dnsError.message || 'Unknown error'}` };
  }
}

// CORS headers — echo origin for credentialed requests
function corsHeaders(request?: NextRequest) {
  const origin = request?.headers?.get('origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    ...(origin !== '*' ? { 'Vary': 'Origin' } : {}),
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * OPTIONS /api/bots/:id/mcp-servers/:serverId/test
 * Handle CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * Check if the current user has access to a bot.
 * Returns the bot on success, throws on failure.
 */
async function getAuthorizedBot(botId: string, actorUserId: string): Promise<{ id: string }> {
  const bot = await prisma.bot.findUnique({
    where: { id: botId },
    select: { id: true, createdById: true },
  });

  if (!bot) {
    throw new Error('NotFound');
  }

  const actorUser = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { email: true },
  });

  const isOwner = bot.createdById === actorUserId;
  const isSuper = actorUser ? isSuperAdmin(actorUser.email) : false;

  if (!isOwner && !isSuper) {
    throw new Error('Forbidden');
  }

  return { id: bot.id };
}

async function testMcpConnection(server: { serverUrl: string; authType: string; authConfig: string | null; headers?: Record<string, string> | null }): Promise<{ success: boolean; toolCount: number; toolNames: string[]; error?: string }> {
  // Decrypt authConfig if present
  let authValue: string | null = null;
  if (server.authConfig) {
    try {
      authValue = decryptApiKey(server.authConfig);
    } catch (error) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: 'Failed to decrypt credentials — encryption key may be misconfigured',
      };
    }
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (server.authType === 'bearer' && authValue) {
    headers['Authorization'] = `Bearer ${authValue}`;
  } else if (server.authType === 'api-key' && authValue) {
    headers['X-API-Key'] = authValue;
  }

  // Merge user-configured custom headers (e.g., multi-tenancy, versioning, Cloudflare bypass)
  if (server.headers) {
    for (const [key, value] of Object.entries(server.headers)) {
      if (typeof value === 'string') {
        headers[key] = value;
      }
    }
  }

  try {
    // SSRF guard: reject internal/private addresses before making network request
    if (!isAllowedServerUrl(server.serverUrl)) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: 'Server URL points to an internal or private address',
      };
    }

    // DNS-level SSRF guard: resolve hostname and verify resolved IPs are not private
    const ipCheck = await isAllowedServerIp(server.serverUrl);
    if (!ipCheck.allowed) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: ipCheck.error || 'Server URL resolves to a blocked address',
      };
    }

    const response = await fetch(server.serverUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: '1',
        method: 'tools/list',
        params: {},
      }),
      signal: AbortSignal.timeout(10000),
      // Follow redirects but validate the final destination is safe
      // (prevents redirect-based SSRF while allowing legitimate HTTP→HTTPS upgrades)
      redirect: 'follow',
    });

    // SSRF guard: if a redirect occurred, verify the final URL is not internal
    if (response.url !== server.serverUrl) {
      if (!isAllowedServerUrl(response.url)) {
        return {
          success: false,
          toolCount: 0,
          toolNames: [],
          error: 'Server redirected to an internal or private address',
        };
      }
      // Also DNS-verify the redirect target
      const redirectIpCheck = await isAllowedServerIp(response.url);
      if (!redirectIpCheck.allowed) {
        return {
          success: false,
          toolCount: 0,
          toolNames: [],
          error: redirectIpCheck.error || 'Redirect target resolves to a blocked address',
        };
      }
    }

    if (!response.ok) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: `HTTP ${response.status}: ${response.statusText}`,
      };
    }

    const data = await response.json();

    if (data?.error) {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: `MCP error: ${data.error.message || JSON.stringify(data.error)}`,
      };
    }

    const tools = data?.result?.tools ?? [];
    const toolNames = tools.map((t: any) => t.name || t.function?.name || 'unknown');
    return {
      success: true,
      toolCount: toolNames.length,
      toolNames,
    };
  } catch (error: any) {
    if (error.name === 'AbortError' || error.name === 'TimeoutError') {
      return {
        success: false,
        toolCount: 0,
        toolNames: [],
        error: 'Connection timed out after 10 seconds',
      };
    }
    return {
      success: false,
      toolCount: 0,
      toolNames: [],
      error: error.message || 'Connection failed',
    };
  }
}

/**
 * POST /api/bots/[id]/mcp-servers/[serverId]/test
 * Test connection to an MCP server. Calls tools/list on the server
 * with the stored auth credentials (decrypted server-side only).
 * Gated by bot ownership or super admin.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; serverId: string }> }
) {
  try {
    const { id: botId, serverId } = await params;

    // Get user from various auth methods (session token, ADMIN_API_TOKEN)
    const sessionUser = await getSessionUser(request);
    let userId: string | null = null;
    let isAdminToken = false;

    if (sessionUser) {
      userId = sessionUser.id;
    } else {
      const authHeader = request.headers.get('authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.replace('Bearer ', '').trim();
        const expectedToken = process.env.ADMIN_API_TOKEN;
        if (expectedToken && token === expectedToken) {
          isAdminToken = true;
        }
      }
    }

    if (!userId && !isAdminToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Admin token skips ownership check (trusted internal call)
    if (!isAdminToken) {
      await getAuthorizedBot(botId, userId!);
    }

    // Fetch the MCP server record (includes encrypted authConfig)
    const server = await prisma.botMcpServer.findUnique({
      where: { id: serverId },
    });

    if (!server || server.botId !== botId) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    // TODO: Flag this bot as having had its MCP server tested?
    // Could add `lastTestedAt` to the schema for observability

    const result = await testMcpConnection(server);

    // Persist test result to DB (fire-and-forget — non-blocking)
    try {
      await prisma.botMcpServer.update({
        where: { id: serverId },
        data: {
          lastTestedAt: new Date(),
          lastTestResult: {
            success: result.success,
            toolCount: result.toolCount,
            toolNames: result.toolNames,
            error: result.error || null,
          },
        },
      });
    } catch (dbError) {
      console.error('Failed to persist MCP test result:', dbError);
      // Don't fail the request — the test already completed
    }

    return NextResponse.json(result, { headers: corsHeaders(request) });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && error.message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (error instanceof Error && error.message === 'NotFound') {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
    }
    console.error('Error testing MCP server connection:', error);
    return NextResponse.json(
      { success: false, toolCount: 0, toolNames: [], error: 'Internal server error' },
      { status: 500 }
    );
  }
}
