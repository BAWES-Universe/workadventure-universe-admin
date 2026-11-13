import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { startOAuth } from '@/lib/mcp/oauth-start';
import { effectiveServer, newSignInNonce } from '@/lib/app-connections';
import { getSessionUser } from '@/lib/auth-session';
import { managesConnection } from '@/lib/app-team-access';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { decryptApiKey } from '@/lib/encryption';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/[id]/mcp-servers/[serverId]/oauth/start
 *
 * Generates an OAuth authorization URL using the provider's authorize endpoint
 * configured in the MCP server's authConfig. Each MCP server stores its own
 * OAuth provider endpoints (authorizeUrl, tokenUrl) alongside client credentials,
 * making this fully provider-agnostic.
 *
 * Query params:
 *   redirectUrl — URL to redirect back to after OAuth completes
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; serverId: string }> }
) {
  try {
    const { id: botId, serverId } = await params;

    // Authenticate
    const sessionUser = await getSessionUser(request);
    let userId: string | null = null;
    let isAdminToken = false;

    if (sessionUser) {
      userId = sessionUser.id;
    } else {
      const authHeader = request.headers.get('authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.replace('Bearer ', '').trim();
        if (token === process.env.ADMIN_API_TOKEN) {
          isAdminToken = true;
        }
      }
    }

    if (!userId && !isAdminToken) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
    }

    // Load the MCP server config
    const server = await prisma.botMcpServer.findUnique({
      where: { id: serverId },
      include: { bot: { select: { id: true, createdById: true, roomId: true, ownerId: true, deletedAt: true, name: true } }, connection: true },
    });

    if (!server || server.botId !== botId) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404, headers: corsHeaders(request) });
    }
    // A Brick's grant on a person's connection signs in through the connection: its link and way in are the connection's
    const effective = effectiveServer(server);

    // Gate: admin token, or someone who can manage this bot's MCP servers
    if (!isAdminToken) {
      const actorUser = await prisma.user.findUnique({
        where: { id: userId! },
        select: { email: true },
      });
      if (!(await canManageBotMcpServers(userId!, actorUser?.email ?? null, server.bot))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders(request) });
      }
      // An app lent by someone else, or a universe's own, signs in only through whoever manages the app itself: a bot's manager
      // starting it would reset the sign-in that person may be in the middle of
      if (server.connection && !(await managesConnection(userId!, server.connection))) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders(request) });
      }
    }

    if (effective.authType !== 'oauth') {
      return NextResponse.json(
        { error: 'Server authType must be "oauth" to start OAuth flow' },
        { status: 400, headers: corsHeaders(request) }
      );
    }

    // Decrypt authConfig and extract OAuth provider config
    let oauthConfig: {
      clientId?: string;
      clientSecret?: string;
      scopes?: string;
      authorizeUrl?: string;
      scopesSupported?: string[] | null;
    };
    try {
      const decrypted = decryptApiKey(effective.authConfig!);
      oauthConfig = JSON.parse(decrypted);
    } catch {
      return NextResponse.json(
        { error: 'Failed to decrypt OAuth configuration' },
        { status: 500, headers: corsHeaders(request) }
      );
    }

    if (!oauthConfig.clientId) {
      return NextResponse.json(
        { error: 'OAuth clientId not configured. Update authConfig with {"clientId":"...","clientSecret":"...","authorizeUrl":"...","tokenUrl":"...","scopes":"..."}' },
        { status: 400, headers: corsHeaders(request) }
      );
    }

    if (!oauthConfig.authorizeUrl) {
      return NextResponse.json(
        { error: 'OAuth authorizeUrl not configured. Provide the OAuth provider\'s authorization endpoint URL.' },
        { status: 400, headers: corsHeaders(request) }
      );
    }

    const started = startOAuth({
      request,
      oauthConfig,
      serverUrl: effective.serverUrl,
      fallbackPath: `/admin/bots/${botId}`,
      state: {
        botId,
        serverId,
        ...(server.connectionId ? { connectionId: server.connectionId, nonce: await newSignInNonce(server.connectionId) } : {}),
        // Who is connecting it, remembered on the connection: the person told if its sign-in expires (game #1819)
        ...(userId ? { personId: userId } : {}),
      },
    });
    if (!started.ok) return NextResponse.json({ error: started.error }, { status: started.status, headers: corsHeaders(request) });
    return NextResponse.json({ authorizeUrl: started.authorizeUrl }, { headers: corsHeaders(request) });
  } catch (error) {
    console.error('[OAuthStart] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
  }
}
