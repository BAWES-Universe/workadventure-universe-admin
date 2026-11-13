import { NextRequest, NextResponse } from 'next/server';
import { testReadyMade } from '@/lib/app-adapter/ready-made';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { ensureFreshOAuthConfig } from '@/lib/mcp/oauth-refresh';
import { testMcpConnection } from '@/lib/mcp/test-connection';
import { corsHeaders } from '@/lib/cors';
import { WITH_CONNECTION, effectiveServer } from '@/lib/app-connections';

export const runtime = 'nodejs';

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
    select: { id: true, createdById: true, roomId: true, ownerId: true, deletedAt: true },
  });

  if (!bot) {
    throw new Error('NotFound');
  }

  const actorUser = await prisma.user.findUnique({
    where: { id: actorUserId },
    select: { email: true },
  });

  if (!(await canManageBotMcpServers(actorUserId, actorUser?.email ?? null, bot))) {
    throw new Error('Forbidden');
  }

  return { id: bot.id };
}

/**
 * POST /api/bots/[id]/mcp-servers/[serverId]/test
 * Test connection to an MCP server. Calls tools/list on the server
 * with the stored auth credentials (decrypted server-side only).
 * Gated by canManageBotMcpServers (room bot manager or super admin).
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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
    }

    // Admin token skips ownership check (trusted internal call)
    if (!isAdminToken) {
      await getAuthorizedBot(botId, userId!);
    }

    // Fetch the MCP server record (includes encrypted authConfig)
    const row = await prisma.botMcpServer.findUnique({
      where: { id: serverId },
      include: WITH_CONNECTION,
    });

    if (!row || row.botId !== botId) {
      return NextResponse.json({ error: 'App not found' }, { status: 404, headers: corsHeaders(request) });
    }
    // A grant on a person's connection is tested with the connection's link and sign-in (game #2001); the result is the Brick's
    const server = effectiveServer(row);

    // lastTestedAt and lastTestResult are persisted below.

    // Renew the access token before testing (#187). A connection whose token has
    // expired is tested — and reported — on a live token, and a connection that
    // cannot be renewed reports that, instead of failing with a bare 401 that says
    // nothing about the fix.
    let authConfigForTest = server.authConfig;
    let reconnectReason: string | null = null;
    if (server.authType === 'oauth' && server.authConfig) {
      const outcome = await ensureFreshOAuthConfig({
        serverId,
        connectionId: server.connectionId,
        authConfig: server.authConfig,
        serverUrl: server.serverUrl,
      });
      if (outcome.authConfig) authConfigForTest = outcome.authConfig;
      if (outcome.status === 'reconnect_required') {
        reconnectReason = outcome.reason ?? 'the stored credentials are no longer usable';
      }
    }

    const result = row.connection?.source === 'ready_made'
      ? // A ready-made app's link needs the provider key, which only Orbit holds: tested through the adapter
        await testReadyMade(row.connection)
      : reconnectReason
      ? {
          success: false as const,
          toolCount: 0,
          toolNames: [] as string[],
          error: `Reconnect required: ${reconnectReason}`,
        }
      : await testMcpConnection({
          serverUrl: server.serverUrl,
          authType: server.authType,
          authConfig: authConfigForTest,
          headers: server.headers as Record<string, string> | null,
        });

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
            ...(result.incomplete ? { incomplete: true } : {}),
            error: result.error || null,
            // Captured from the failure path (#186) so a stored result names the
            // cause instead of only the status text.
            status: result.status ?? null,
            statusText: result.statusText ?? null,
            errorCode: result.errorCode ?? null,
            wwwAuthenticate: result.wwwAuthenticate ?? null,
            errorBody: result.errorBody ?? null,
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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
    }
    if (error instanceof Error && error.message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders(request) });
    }
    if (error instanceof Error && error.message === 'NotFound') {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404, headers: corsHeaders(request) });
    }
    console.error('Error testing MCP server connection:', error);
    return NextResponse.json(
      { success: false, toolCount: 0, toolNames: [], error: 'Internal server error' },
      { status: 500, headers: corsHeaders(request) }
    );
  }
}
