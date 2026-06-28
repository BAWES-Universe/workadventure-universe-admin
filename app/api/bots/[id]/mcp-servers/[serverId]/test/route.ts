import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { decryptApiKey } from '@/lib/encryption';

export const runtime = 'nodejs';

// CORS headers helper
function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, DELETE',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * OPTIONS /api/bots/:id/mcp-servers/:serverId/test
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
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

async function testMcpConnection(server: { serverUrl: string; authType: string; authConfig: string | null }): Promise<{ success: boolean; toolCount: number; toolNames: string[]; error?: string }> {
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

  try {
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
    });

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
    if (error.name === 'AbortError') {
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
    return NextResponse.json(result, { headers: corsHeaders() });
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
