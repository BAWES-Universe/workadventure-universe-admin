import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { encryptApiKey, decryptApiKey } from '@/lib/encryption';
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
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1') return false;
    if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return false;
    if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) return false;
    if (/^192\.168\.\d+\.\d+$/.test(hostname)) return false;
    if (/^169\.\d+\.\d+\.\d+$/.test(hostname)) return false;
    // Reject private IPv6 ranges (unique-local, link-local, unspecified)
    if (/^f[cd][0-9a-f]{0,3}:/i.test(hostname)) return false;
    if (/^fe80:/i.test(hostname)) return false;
    if (/^::$/.test(hostname)) return false;
    if (hostname === '169.254.169.254') return false;
    if (hostname === 'metadata.google.internal' || hostname === 'metadata.internal') return false;
    if (hostname.endsWith('.internal')) return false;
    return true;
  } catch {
    return false;
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
 * OPTIONS /api/bots/:id/mcp-servers/:serverId
 * Handle CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

// Validation schema for updating an MCP server (all fields optional)
const updateMcpServerSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').max(255).optional(),
  serverUrl: z.string().url('serverUrl must be a valid URL').refine(
    (url) => isAllowedServerUrl(url),
    { message: 'Server URL must not point to internal or private addresses' }
  ).optional(),
  authType: z.enum(['none', 'bearer', 'api-key']).optional(),
  authConfig: z.string().optional().nullable(),
  headers: z.record(z.string(), z.string()).refine(
    (headers) => {
      const reserved = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'];
      return !Object.keys(headers).some((key) => reserved.includes(key.toLowerCase()));
    },
    { message: 'Headers must not include reserved credentials: Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-API-Key' }
  ).optional(),
  enabled: z.boolean().optional(),
});

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

/**
 * PATCH /api/bots/[id]/mcp-servers/[serverId]
 * Update an MCP server. Re-encrypts authConfig if changed.
 */
export async function PATCH(
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

    // Fetch existing server
    const existing = await prisma.botMcpServer.findUnique({
      where: { id: serverId },
    });

    if (!existing || existing.botId !== botId) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    const body = await request.json();
    const validatedData = updateMcpServerSchema.parse(body);

    // Build update data
    const updateData: Record<string, unknown> = {};
    if (validatedData.name !== undefined) updateData.name = validatedData.name;
    if (validatedData.serverUrl !== undefined) updateData.serverUrl = validatedData.serverUrl;
    // Determine effective auth type after update (existing + incoming changes)
    const effectiveAuthType = validatedData.authType ?? existing.authType;

    if (validatedData.authType !== undefined) {
      updateData.authType = validatedData.authType;
      if (validatedData.authType === 'none') {
        updateData.authConfig = null;
      }
    }

    if (validatedData.enabled !== undefined) updateData.enabled = validatedData.enabled;

    if (validatedData.headers !== undefined) updateData.headers = validatedData.headers;

    // Handle authConfig based on effective auth type
    if (validatedData.authConfig === undefined) {
      // authConfig not in the request body
      if (validatedData.authType !== undefined && validatedData.authType !== existing.authType) {
        // Auth type changed without providing new config — clear old secret
        updateData.authConfig = null;
      }
      // else: keep existing authConfig (unchanged)
    } else if (validatedData.authConfig === null || validatedData.authConfig === '') {
      // Explicitly clearing authConfig
      updateData.authConfig = null;
    } else if (validatedData.authType !== 'none') {
      // New authConfig provided for a non-none auth type (explicitly), or
      // authType was not specified — encrypt it
      try {
        updateData.authConfig = encryptApiKey(validatedData.authConfig);
      } catch (encError) {
        console.error('Failed to encrypt authConfig:', encError);
        return NextResponse.json(
          { error: 'Failed to encrypt auth configuration' },
          { status: 500 }
        );
      }
    }

    const updated = await prisma.botMcpServer.update({
      where: { id: serverId },
      data: updateData,
    });

    return NextResponse.json({
      id: updated.id,
      botId: updated.botId,
      name: updated.name,
      serverUrl: updated.serverUrl,
      authType: updated.authType,
      enabled: updated.enabled,
      headers: updated.headers,
      lastTestedAt: updated.lastTestedAt,
      lastTestResult: updated.lastTestResult,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    }, { headers: corsHeaders(request) });
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
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input data', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error updating MCP server:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * DELETE /api/bots/[id]/mcp-servers/[serverId]
 * Delete an MCP server. Returns 204.
 */
export async function DELETE(
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

    // Fetch existing server to verify ownership
    const existing = await prisma.botMcpServer.findUnique({
      where: { id: serverId },
    });

    if (!existing || existing.botId !== botId) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    await prisma.botMcpServer.delete({
      where: { id: serverId },
    });

    return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
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
    console.error('Error deleting MCP server:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
