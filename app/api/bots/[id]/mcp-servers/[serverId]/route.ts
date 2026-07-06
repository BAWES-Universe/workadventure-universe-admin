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
  authType: z.enum(['none', 'bearer', 'api-key', 'oauth']).optional(),
  authConfig: z.string().trim().optional().nullable().transform(val => val === '' ? null : val),
  headers: z.record(z.string(), z.string()).refine(
    (headers) => {
      const reserved = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'];
      return !Object.keys(headers).some((key) => reserved.includes(key.toLowerCase()));
    },
    { message: 'Headers must not include reserved credentials: Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-API-Key' }
  ).optional(),
  enabled: z.boolean().optional(),
}).superRefine((data, ctx) => {
  if (data.authType !== undefined && data.authType !== 'none') {
    // If authType is being set to bearer/api-key and authConfig is also in the request but empty
    if (data.authConfig !== undefined && (!data.authConfig || !data.authConfig.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authConfig'],
        message: `authConfig must be non-empty when authType is '${data.authType}'`,
      });
    }
  }
  if (data.authType === 'oauth' && data.authConfig && data.authConfig.trim()) {
    // Validate the OAuth config JSON — for full replacements, require the
    // standard fields; partial updates (scopes-only from connected server)
    // will be merged server-side and are validated by the PATCH handler.
    try {
      const parsed = JSON.parse(data.authConfig);
      // If the config has none of the endpoint fields, it's a partial update
      // that will be merged with the stored config — no full validation needed.
      const hasEndpointFields = parsed.authorizeUrl || parsed.tokenUrl || parsed.clientId;
      if (hasEndpointFields) {
        const required = ['clientId', 'authorizeUrl', 'tokenUrl'];
        for (const field of required) {
          if (!parsed[field] || typeof parsed[field] !== 'string' || !parsed[field].toString().trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['authConfig'],
              message: `OAuth '${field}' is required and must be a non-empty string`,
            });
            return;
          }
        }
        // If clientSecret is provided, it must be a non-empty string
        if (parsed.clientSecret !== undefined && parsed.clientSecret !== null) {
          if (typeof parsed.clientSecret !== 'string' || !parsed.clientSecret.toString().trim()) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['authConfig'],
              message: `OAuth 'clientSecret' must be a non-empty string if provided`,
            });
            return;
          }
        }
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authConfig'],
        message: 'authConfig must be valid JSON for OAuth authentication',
      });
    }
  }
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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
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
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404, headers: corsHeaders(request) });
    }

    const body = await request.json();
    const validatedData = updateMcpServerSchema.parse(body);

    // Build update data
    const updateData: Record<string, unknown> = {};
    if (validatedData.name !== undefined) updateData.name = validatedData.name;
    if (validatedData.serverUrl !== undefined) updateData.serverUrl = validatedData.serverUrl;
    // Determine effective auth type after update (existing + incoming changes)
    const effectiveAuthType = validatedData.authType ?? existing.authType;

    // If the effective auth type is OAuth and authConfig is being updated, validate required fields
    // Skip full validation for partial updates on existing OAuth servers (e.g., scopes-only)
    // — the merge logic later handles putting it together with the stored config.
    if (
      effectiveAuthType === 'oauth' &&
      validatedData.authConfig !== undefined &&
      validatedData.authConfig !== null &&
      validatedData.authConfig.trim()
    ) {
      // Always parse the incoming authConfig — needed for field-level validation below.
      let parsedConfig: Record<string, unknown>;
      try {
        parsedConfig = JSON.parse(validatedData.authConfig);
      } catch {
        return NextResponse.json(
          { error: 'authConfig must be valid JSON for OAuth authentication' },
          { status: 400, headers: corsHeaders(request) }
        );
      }

      if (!(existing.authType === 'oauth' && existing.authConfig)) {
        // Full replacement (non-OAuth→OAuth or first-time OAuth) — require all standard fields
        const requiredFields = ['clientId', 'authorizeUrl', 'tokenUrl'];
        for (const field of requiredFields) {
          if (!parsedConfig[field] || typeof parsedConfig[field] !== 'string' || !parsedConfig[field].toString().trim()) {
            return NextResponse.json(
              { error: `OAuth '${field}' is required and must be a non-empty string` },
              { status: 400, headers: corsHeaders(request) }
            );
          }
        }
        // clientSecret is optional — public OAuth clients (PKCE) have no secret
        if (parsedConfig.clientSecret !== undefined && parsedConfig.clientSecret !== null) {
          if (typeof parsedConfig.clientSecret !== 'string' || !parsedConfig.clientSecret.toString().trim()) {
            return NextResponse.json(
              { error: `OAuth 'clientSecret' must be a non-empty string if provided` },
              { status: 400, headers: corsHeaders(request) }
            );
          }
        }
      } else {
        // Partial update on existing OAuth server — validate only provided fields
        if (parsedConfig.authorizeUrl !== undefined) {
          if (typeof parsedConfig.authorizeUrl !== 'string' || !parsedConfig.authorizeUrl.toString().trim()) {
            return NextResponse.json(
              { error: `OAuth 'authorizeUrl' must be a non-empty string` },
              { status: 400, headers: corsHeaders(request) }
            );
          }
          try {
            const url = new URL(parsedConfig.authorizeUrl as string);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
              throw new Error();
            }
          } catch {
            return NextResponse.json(
              { error: `OAuth 'authorizeUrl' must be a valid URL with http or https protocol` },
              { status: 400, headers: corsHeaders(request) }
            );
          }
        }
        if (parsedConfig.tokenUrl !== undefined) {
          if (typeof parsedConfig.tokenUrl !== 'string' || !parsedConfig.tokenUrl.toString().trim()) {
            return NextResponse.json(
              { error: `OAuth 'tokenUrl' must be a non-empty string` },
              { status: 400, headers: corsHeaders(request) }
            );
          }
          try {
            const url = new URL(parsedConfig.tokenUrl as string);
            if (url.protocol !== 'http:' && url.protocol !== 'https:') {
              throw new Error();
            }
          } catch {
            return NextResponse.json(
              { error: `OAuth 'tokenUrl' must be a valid URL with http or https protocol` },
              { status: 400, headers: corsHeaders(request) }
            );
          }
        }
        if (parsedConfig.clientId !== undefined) {
          if (typeof parsedConfig.clientId !== 'string' || !parsedConfig.clientId.toString().trim()) {
            return NextResponse.json(
              { error: `OAuth 'clientId' must be a non-empty string` },
              { status: 400, headers: corsHeaders(request) }
            );
          }
        }
        if (parsedConfig.clientSecret !== undefined && parsedConfig.clientSecret !== null) {
          if (typeof parsedConfig.clientSecret !== 'string' || !parsedConfig.clientSecret.toString().trim()) {
            return NextResponse.json(
              { error: `OAuth 'clientSecret' must be a non-empty string if provided` },
              { status: 400, headers: corsHeaders(request) }
            );
          }
        }
      }
    }

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
        // Auth type changed without providing new config
        if (validatedData.authType === 'bearer' || validatedData.authType === 'api-key' || validatedData.authType === 'oauth') {
          return NextResponse.json(
            { error: `authConfig is required when changing authType to '${validatedData.authType}'` },
            { status: 400, headers: corsHeaders(request) }
          );
        }
        // Switching to 'none' — clear the secret
        updateData.authConfig = null;
      }
      // else: keep existing authConfig (unchanged)
    } else if (validatedData.authConfig === null || validatedData.authConfig === '') {
      // Explicitly clearing authConfig
      updateData.authConfig = null;
    } else if (effectiveAuthType !== 'none') {
      try {
        // For existing OAuth servers, merge partial updates with the stored config
        // (e.g., frontend sends { scopes: "new" }, merged with existing endpoints/tokens)
        if (existing.authConfig && existing.authType === 'oauth' && effectiveAuthType === 'oauth') {
          const existingDecrypted = decryptApiKey(existing.authConfig);
          const existingParsed = JSON.parse(existingDecrypted);
          const incomingParsed = JSON.parse(validatedData.authConfig);
          // Merge: incoming fields overlay existing (partial update supported)
          // If OAuth endpoint URLs changed (switching providers), clear stale tokens
          if (
            (incomingParsed.authorizeUrl && incomingParsed.authorizeUrl !== existingParsed.authorizeUrl) ||
            (incomingParsed.tokenUrl && incomingParsed.tokenUrl !== existingParsed.tokenUrl)
          ) {
            incomingParsed.accessToken = null;
            incomingParsed.refreshToken = null;
            incomingParsed.expiresAt = null;
          }
          const merged = { ...existingParsed, ...incomingParsed };
          updateData.authConfig = encryptApiKey(JSON.stringify(merged));
        } else {
          // Full replacement for non-OAuth or switching auth types
          updateData.authConfig = encryptApiKey(validatedData.authConfig);
        }
      } catch (encError) {
        console.error('Failed to encrypt authConfig:', encError);
        return NextResponse.json(
          { error: 'Failed to encrypt auth configuration' },
          { status: 500, headers: corsHeaders(request) }
        );
      }
    } else {
      // authConfig provided but effectiveAuthType is 'none' — store it only
      // if authType isn't being explicitly cleared to 'none' at the same time
      if (validatedData.authType !== 'none') {
        try {
          updateData.authConfig = encryptApiKey(validatedData.authConfig);
        } catch (encError) {
          console.error('Failed to encrypt authConfig:', encError);
          return NextResponse.json(
            { error: 'Failed to encrypt auth configuration' },
            { status: 500, headers: corsHeaders(request) }
          );
        }
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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
    }
    if (error instanceof Error && error.message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: corsHeaders(request) });
    }
    if (error instanceof Error && error.message === 'NotFound') {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404, headers: corsHeaders(request) });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input data', details: error.issues },
        { status: 400, headers: corsHeaders(request) }
      );
    }
    console.error('Error updating MCP server:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: corsHeaders(request) });
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
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404, headers: corsHeaders(request) });
    }

    await prisma.botMcpServer.delete({
      where: { id: serverId },
    });

    return new NextResponse(null, { status: 204, headers: corsHeaders(request) });
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
    console.error('Error deleting MCP server:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500, headers: corsHeaders(request) });
  }
}