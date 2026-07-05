import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import crypto from 'crypto';

export const runtime = 'nodejs';

// CORS headers
function corsHeaders(request?: NextRequest) {
  const origin = request?.headers?.get('origin');
  if (!origin) {
    return {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
  }
  const trustedOrigins = (process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean);
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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
      include: { bot: { select: { id: true, createdById: true, name: true } } },
    });

    if (!server || server.botId !== botId) {
      return NextResponse.json({ error: 'Server not found' }, { status: 404, headers: corsHeaders(request) });
    }

    // Gate: admin token or bot owner
    if (!isAdminToken) {
      const actorUser = await prisma.user.findUnique({
        where: { id: userId! },
        select: { email: true },
      });
      const isOwner = server.bot.createdById === userId;
      const isSuper = actorUser ? isSuperAdmin(actorUser.email) : false;
      if (!isOwner && !isSuper) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders(request) });
      }
    }

    if (server.authType !== 'oauth') {
      return NextResponse.json(
        { error: 'Server authType must be "oauth" to start OAuth flow' },
        { status: 400, headers: corsHeaders(request) }
      );
    }

    // Decrypt authConfig and extract OAuth provider config
    let oauthConfig: { clientId?: string; clientSecret?: string; scopes?: string; authorizeUrl?: string };
    try {
      const decrypted = decryptApiKey(server.authConfig!);
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

    // Get redirect URL from query param or build default
    // Must always be absolute — it's stored in the state token and later passed to
    // new URL() in the callback endpoint. Relative paths like "/admin/bots/..." would
    // throw TypeError: Invalid URL.
    const { searchParams } = new URL(request.url);
    const requestOrigin = new URL(request.url).origin;
    let redirectUrl = searchParams.get('redirectUrl');
    if (redirectUrl) {
      // Validate redirectUrl against allowed origins to prevent open redirect
      const allowedOrigins = [
        requestOrigin,
        ...(process.env.CORS_ALLOWED_ORIGINS || '').split(',').filter(Boolean),
        ...(request.headers.get('origin') ? [request.headers.get('origin')!] : []),
      ];
      const isAllowed = allowedOrigins.some((origin) => {
        try {
          return new URL(redirectUrl!).origin === origin;
        } catch {
          return false;
        }
      });
      if (!isAllowed) {
        redirectUrl = `${requestOrigin}/admin/bots/${botId}`;
      }
    } else {
      const origin = request.headers.get('origin') || process.env.CORS_ALLOWED_ORIGINS?.split(',')[0] || requestOrigin;
      redirectUrl = `${origin}/admin/bots/${botId}`;
    }

    // Generate PKCE code verifier and challenge (S256)
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto
      .createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    // Build state token: encrypted JSON with botId, serverId, redirectUrl, codeVerifier
    const statePayload = JSON.stringify({
      botId, serverId, redirectUrl,
      codeVerifier,
      ts: Date.now(),
    });
    const stateToken = encryptApiKey(statePayload);

    // Validate authorizeUrl before constructing the redirect
    try {
      new URL(oauthConfig.authorizeUrl);
    } catch {
      return NextResponse.json(
        { error: 'Invalid authorizeUrl in authConfig — must be a valid, absolute URL' },
        { status: 400, headers: corsHeaders(request) }
      );
    }

    // Build authorize URL from the provider's configured endpoint
    const authorizeUrl = new URL(oauthConfig.authorizeUrl);
    const callbackBase = process.env.ADMIN_API_URL || new URL(request.url).origin;
    authorizeUrl.searchParams.set('response_type', 'code');
    authorizeUrl.searchParams.set('client_id', oauthConfig.clientId);
    authorizeUrl.searchParams.set('redirect_uri', `${callbackBase}/api/oauth/mcp-callback`);
    authorizeUrl.searchParams.set('scope', oauthConfig.scopes || '');
    authorizeUrl.searchParams.set('state', stateToken);
    authorizeUrl.searchParams.set('code_challenge', codeChallenge);
    authorizeUrl.searchParams.set('code_challenge_method', 'S256');

    return NextResponse.json(
      { authorizeUrl: authorizeUrl.toString() },
      { headers: corsHeaders(request) }
    );
  } catch (error) {
    console.error('[OAuthStart] Error:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
  }
}
