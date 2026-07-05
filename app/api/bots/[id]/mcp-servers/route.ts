import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { encryptApiKey } from '@/lib/encryption';
import { z } from 'zod';

export const runtime = 'nodejs';

// Reject MCP server URLs that point to internal infrastructure (SSRF prevention)
function isAllowedServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
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
    return true;
  } catch {
    return false;
  }
}

// CORS headers — only echo origin with credentials for trusted origins
function corsHeaders(request?: NextRequest) {
  const origin = request?.headers?.get('origin');
  if (!origin) {
    // Same-origin request (no Origin header) — no CORS needed
    return {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }
  // Only allow credentials for known admin/play domains.
  // When CORS_ALLOWED_ORIGINS is unset, deny all cross-origin access (fail-closed).
  const trustedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  if (trustedOrigins.length === 0 || !trustedOrigins.includes(origin)) {
    // No allowlist configured OR origin not in allowlist — deny cross-origin reads
    return {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
    };
  }
  // Trusted origin — echo with credentials
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
  headers['Access-Control-Allow-Credentials'] = 'true';
  return headers;
}

/**
 * OPTIONS /api/bots/:id/mcp-servers
 * Handle CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

// Validation schema for creating an MCP server
const createMcpServerSchema = z.object({
  name: z.string().min(1, 'name is required').max(255, 'name must be at most 255 characters'),
  serverUrl: z.string().url('serverUrl must be a valid URL').refine(
    (url) => isAllowedServerUrl(url),
    { message: 'Server URL must not point to internal or private addresses' }
  ),
  authType: z.enum(['none', 'bearer', 'api-key', 'oauth'], {
    message: 'authType must be one of: none, bearer, api-key, oauth',
  }).default('none'),
  authConfig: z.string().trim().optional().nullable(),
  headers: z.record(z.string(), z.string()).refine(
    (headers) => {
      const reserved = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'];
      return !Object.keys(headers).some((key) => reserved.includes(key.toLowerCase()));
    },
    { message: 'Headers must not include reserved credentials: Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-API-Key' }
  ).optional(),
  enabled: z.boolean().optional().default(true),
}).superRefine((data, ctx) => {
  if ((data.authType === 'bearer' || data.authType === 'api-key' || data.authType === 'oauth') && !data.authConfig) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authConfig'],
      message: `authConfig is required when authType is '${data.authType}'`,
    });
  }
});

/**
 * GET /api/bots/[id]/mcp-servers
 * List all MCP servers for a bot. Gated by: requester matches bot's createdById OR is super admin.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: botId } = await params;

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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
    }

    // Fetch the bot to check ownership
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: { id: true, createdById: true },
    });

    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404, headers: corsHeaders(request) });
    }

    // Gate: admin token skips ownership check (trusted internal call)
    if (!isAdminToken) {
      const actorUser = await prisma.user.findUnique({
        where: { id: userId! },
        select: { email: true },
      });
      const isOwner = bot.createdById === userId;
      const isSuper = actorUser ? isSuperAdmin(actorUser.email) : false;

      if (!isOwner && !isSuper) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders(request) });
      }
    }

    const servers = await prisma.botMcpServer.findMany({
      where: { botId },
      orderBy: { createdAt: 'asc' },
    });

    // Transform: remove authConfig from response for security,
    // except for internal bot-server calls authenticated via ADMIN_API_TOKEN
    const transformed = servers.map((s) => ({
      id: s.id,
      botId: s.botId,
      name: s.name,
      serverUrl: s.serverUrl,
      authType: s.authType,
      ...(isAdminToken ? { authConfig: s.authConfig } : {}),
      enabled: s.enabled,
      headers: s.headers,
      lastTestedAt: s.lastTestedAt,
      lastTestResult: s.lastTestResult,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    return NextResponse.json(transformed, { headers: corsHeaders(request) });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
    }
    if (error instanceof Error && error.message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders(request) });
    }
    console.error('Error listing MCP servers:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
  }
}

/**
 * POST /api/bots/[id]/mcp-servers
 * Create a new MCP server for a bot. Soft cap of 5 servers per bot.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: botId } = await params;

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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
    }

    // Fetch the bot to check ownership
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: { id: true, createdById: true },
    });

    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404, headers: corsHeaders(request) });
    }

    // Gate: admin token skips ownership check (trusted internal call)
    if (!isAdminToken) {
      const actorUser = await prisma.user.findUnique({
        where: { id: userId! },
        select: { email: true },
      });
      const isOwner = bot.createdById === userId;
      const isSuper = actorUser ? isSuperAdmin(actorUser.email) : false;

      if (!isOwner && !isSuper) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders(request) });
      }
    }

    // Parse and validate request body
    const body = await request.json();
    const validatedData = createMcpServerSchema.parse(body);

    // Encrypt authConfig if provided (store even when authType is 'none',
    // consistent with the PATCH handler — user explicitly provided it)
    let encryptedAuthConfig: string | null = null;
    if (validatedData.authConfig) {
      try {
        encryptedAuthConfig = encryptApiKey(validatedData.authConfig);
      } catch (encError) {
        console.error('Failed to encrypt authConfig:', encError);
        return NextResponse.json(
          { error: 'Failed to encrypt auth configuration' },
          { status: 500, headers: corsHeaders(request) }
        );
      }
    }

    // Soft cap: reject if bot already has 5 servers (atomic check+create)
    const server = await prisma.$transaction(async (tx) => {
      const existingCount = await tx.botMcpServer.count({
        where: { botId },
      });

      if (existingCount >= 5) {
        throw new Error('MaxServersReached');
      }

      return tx.botMcpServer.create({
        data: {
          botId,
          name: validatedData.name,
          serverUrl: validatedData.serverUrl,
          authType: validatedData.authType,
          authConfig: encryptedAuthConfig,
          headers: validatedData.headers ?? undefined,
          enabled: validatedData.enabled,
        },
      });
    });

    return NextResponse.json(
      {
        id: server.id,
        botId: server.botId,
        name: server.name,
        serverUrl: server.serverUrl,
        authType: server.authType,
        enabled: server.enabled,
        headers: server.headers,
        lastTestedAt: server.lastTestedAt,
        lastTestResult: server.lastTestResult,
        createdAt: server.createdAt,
        updatedAt: server.updatedAt,
      },
      { status: 201, headers: corsHeaders(request) }
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'MaxServersReached') {
      return NextResponse.json(
        { error: 'Maximum of 5 MCP servers per bot reached' },
        { status: 422, headers: corsHeaders(request) }
      );
    }
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
    }
    if (error instanceof Error && error.message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders(request) });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input data', details: error.issues },
        { status: 400, headers: corsHeaders(request) }
      );
    }
    console.error('Error creating MCP server:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
  }
}
