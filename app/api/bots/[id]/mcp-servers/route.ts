import { AppsFull, claimAppSlot } from '@/lib/bot-limits';
import { botUniverseId } from '@/lib/app-uses';
import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { isReconnectRequired, parseOAuthConfig, refreshBlockedReason } from '@/lib/mcp/oauth-token';
import { ensureFreshOAuthConfig } from '@/lib/mcp/oauth-refresh';
import { getSessionUser } from '@/lib/auth-session';
import { canManageBotMcpServers } from '@/lib/bot-permissions';
import { encryptApiKey, decryptApiKey } from '@/lib/encryption';
import { z } from 'zod';
import { corsHeaders } from '@/lib/cors';
import { createMcpServerSchema } from '@/lib/mcp/server-input';
import { WITH_CONNECTION, effectiveServer } from '@/lib/app-connections';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/:id/mcp-servers
 * Handle CORS preflight
 */
export async function OPTIONS(request: NextRequest) {
  return NextResponse.json({}, { headers: corsHeaders(request) });
}

/**
 * GET /api/bots/[id]/mcp-servers
 * List all MCP servers for a bot. Gated by canManageBotMcpServers: anyone who can manage bots in its room, or a super admin.
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
      select: { id: true, createdById: true, roomId: true, ownerId: true, deletedAt: true },
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

      if (!(await canManageBotMcpServers(userId!, actorUser?.email ?? null, bot))) {
        // The same answer as for a bot that does not exist, so a stranger learns nothing about it
        return NextResponse.json({ error: 'Bot not found' }, { status: 404, headers: corsHeaders(request) });
      }
    }

    // A grant on a person's connection (game #2001) is read together with it: the link, the way in and the sign-in lost
    // fields are the connection's, never copies on the row. A bot's own server is read as before.
    const servers = (
      await prisma.botMcpServer.findMany({
        // An app with a key (game #2044) is not an app link: the bot server gets it from GET .../key-apps, never as a server to connect to
        where: { botId, OR: [{ connectionId: null }, { connection: { kind: { not: 'direct' } } }] },
        include: WITH_CONNECTION,
        orderBy: { createdAt: 'asc' },
      })
    ).map((row) => effectiveServer(row));

    // Transform: remove authConfig from response for security,
    // except for internal bot-server calls authenticated via ADMIN_API_TOKEN
    // For OAuth servers, check if connected (has accessToken) without exposing credentials
    // Where each grant comes from: one of the bot's own maker's apps (a Brick), a person's app lent to this bot's universe (with what the
    // lender allowed), or the universe's own app. The bot server holds the limits again at every use (POST .../use).
    const universeId = bot.roomId ? await botUniverseId(botId) : null;
    const lends = universeId && servers.some((row) => row.connectionId)
      ? await prisma.appLend.findMany({ where: { universeId, connectionId: { in: servers.map((row) => row.connectionId).filter((id): id is string => !!id) } }, select: { connectionId: true, things: true, usesPerDay: true } })
      : [];
    // A grant on someone else's connection (lent to this universe, or the universe's own) shows its manager the app's name and state,
    // never its address or headers: the address can carry a key, and the lender never agreed to show it to everyone who manages bots.
    // A ready-made app's address is the provider's and is never shown to a person. Only the bot server (admin token) is handed them.
    const seesWay = (s: (typeof servers)[number]) => isAdminToken || !s.connection || (s.connection.ownerId === userId && s.connection.source !== 'ready_made');
    const lendOf = new Map(lends.map((lend) => [lend.connectionId, lend]));
    const transformed = await Promise.all(
      servers.map(async (s) => {
        let oauthConnected = false;
        let oauthReconnectReason: string | null = null;
        // The access token's expiry, exposed to the UI so a stored green result can
        // be told apart from a live connection (#186). Not secret: it is a timestamp,
        // and the token itself is never sent here.
        let oauthExpiresAt: string | null = null;
        let authConfigToServe = s.authConfig;
        if (s.authType === 'oauth' && s.authConfig) {
          try {
            let config = parseOAuthConfig(decryptApiKey(s.authConfig));
            // Internal callers (the bots) are handed the credentials, so this is where
            // a token must be renewed before it is served. Admin reads only report
            // state — they must not trigger a refresh on every page view (#187).
            if (isAdminToken) {
              const outcome = await ensureFreshOAuthConfig({
                serverId: s.id,
                connectionId: s.connectionId,
                authConfig: s.authConfig,
                serverUrl: s.serverUrl,
              });
              if (outcome.authConfig) authConfigToServe = outcome.authConfig;
              if (outcome.config) config = outcome.config;
            }
            // A panel read never refreshes, so the stored marker alone is not enough: a
            // connection whose token has expired and that has no refresh token is already
            // beyond automatic recovery, and calling it connected hides the Reconnect
            // action until some bot poll or Test run writes the marker. Ask the token
            // rules directly instead (#190 review).
            const needsHuman = !!config && !!config.accessToken && isReconnectRequired(config);
            oauthConnected = !!config?.accessToken && !needsHuman;
            oauthReconnectReason =
              config?.reconnectRequired?.reason ??
              (config && needsHuman ? refreshBlockedReason(config) : null);
            if (typeof config?.expiresAt === 'number' && Number.isFinite(config.expiresAt)) {
              const expiresAt = new Date(config.expiresAt * 1000);
              // A finite number is not necessarily a representable date. An out-of-range
              // value made toISOString() throw into the catch below while oauthConnected
              // was already set, reporting a live connection with no expiry (#186 review).
              if (!Number.isNaN(expiresAt.getTime())) {
                oauthExpiresAt = expiresAt.toISOString();
              }
            }
          } catch {
            // If decrypt fails, assume not connected
          }
        }
          return {
            id: s.id,
            botId: s.botId,
            name: s.name,
            serverUrl: seesWay(s) ? s.serverUrl : '',
            authType: s.authType,
            // A person's GitHub (game #2041) is answered by Orbit itself: its token is never handed out, not even to the bot server
            ...(isAdminToken && s.connection?.source !== 'github' ? { authConfig: authConfigToServe } : {}),
            oauthConnected,
            oauthExpiresAt,
            // Set when refreshing is impossible and only a human can fix it (#187).
            oauthReconnectRequired: !!oauthReconnectReason,
            oauthReconnectReason,
            enabled: s.enabled,
            // Set for a Brick's grant on a person's connection: its link and sign-in are changed on the app's own page
            connectionId: s.connectionId,
            // A ready-made app: the bot server never calls its link itself (it needs the provider key, which stays in Orbit), it goes through
            // POST /api/ready-made/link. False for every other server.
            readyMade: s.connection?.source === 'ready_made' || s.connection?.source === 'github',
            // Set when a person's app is lent to this bot's universe: what the lender allowed (null = all four) and the uses a day
            ...(lendOf.has(s.connectionId ?? '') ? { lent: { things: lendOf.get(s.connectionId as string)!.things, usesPerDay: lendOf.get(s.connectionId as string)!.usesPerDay } } : {}),
            // A server that existed before its tools were checked keeps working in text, and reads Not checked yet (#738)
            notCheckedYet: s.legacyText === true,
            policyRevision: s.policyRevision ?? 1,
            headers: seesWay(s) ? s.headers : null,
            lastTestedAt: s.lastTestedAt,
            lastTestResult: s.lastTestResult,
            // What the bot server saw when it really used the server, not only the last Test (game #1819)
            signInLostAt: s.signInLostAt,
            signInLostStatus: s.signInLostStatus,
            noAnswerAt: s.noAnswerAt,
            reconnectedAt: s.reconnectedAt,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
          };
      })
    );

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
      select: { id: true, createdById: true, roomId: true, ownerId: true, deletedAt: true },
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

      if (!(await canManageBotMcpServers(userId!, actorUser?.email ?? null, bot))) {
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
      await claimAppSlot(tx, botId);

      return tx.botMcpServer.create({
        data: {
          botId,
          // Who added it is who is told when its sign-in or key stops working (none for the admin token)
          connectedById: userId,
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
    if (error instanceof AppsFull) {
      return NextResponse.json(
        { error: error.message },
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
