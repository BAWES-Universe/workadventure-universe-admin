import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { encryptApiKey } from '@/lib/encryption';
import { z } from 'zod';

export const runtime = 'nodejs';

// Validation schema for creating an MCP server
const createMcpServerSchema = z.object({
  name: z.string().min(1, 'name is required').max(255, 'name must be at most 255 characters'),
  serverUrl: z.string().url('serverUrl must be a valid URL'),
  authType: z.enum(['none', 'bearer', 'api-key'], {
    message: 'authType must be one of: none, bearer, api-key',
  }).default('none'),
  authConfig: z.string().optional().nullable(),
  enabled: z.boolean().optional().default(true),
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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch the bot to check ownership
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: { id: true, createdById: true },
    });

    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
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
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const servers = await prisma.botMcpServer.findMany({
      where: { botId },
      orderBy: { createdAt: 'asc' },
    });

    // Transform: remove authConfig from response for security
    const transformed = servers.map((s) => ({
      id: s.id,
      botId: s.botId,
      name: s.name,
      serverUrl: s.serverUrl,
      authType: s.authType,
      enabled: s.enabled,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));

    return NextResponse.json(transformed);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && error.message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    console.error('Error listing MCP servers:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
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
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Fetch the bot to check ownership
    const bot = await prisma.bot.findUnique({
      where: { id: botId },
      select: { id: true, createdById: true },
    });

    if (!bot) {
      return NextResponse.json({ error: 'Bot not found' }, { status: 404 });
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
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    // Parse and validate request body
    const body = await request.json();
    const validatedData = createMcpServerSchema.parse(body);

    // Soft cap: reject if bot already has 5 servers
    const existingCount = await prisma.botMcpServer.count({
      where: { botId },
    });

    if (existingCount >= 5) {
      return NextResponse.json(
        { error: 'Maximum of 5 MCP servers per bot reached' },
        { status: 422 }
      );
    }

    // Encrypt authConfig if provided
    let encryptedAuthConfig: string | null = null;
    if (validatedData.authConfig) {
      try {
        encryptedAuthConfig = encryptApiKey(validatedData.authConfig);
      } catch (encError) {
        console.error('Failed to encrypt authConfig:', encError);
        return NextResponse.json(
          { error: 'Failed to encrypt auth configuration' },
          { status: 500 }
        );
      }
    }

    const server = await prisma.botMcpServer.create({
      data: {
        botId,
        name: validatedData.name,
        serverUrl: validatedData.serverUrl,
        authType: validatedData.authType,
        authConfig: encryptedAuthConfig,
        enabled: validatedData.enabled,
      },
    });

    return NextResponse.json(
      {
        id: server.id,
        botId: server.botId,
        name: server.name,
        serverUrl: server.serverUrl,
        authType: server.authType,
        enabled: server.enabled,
        createdAt: server.createdAt,
        updatedAt: server.updatedAt,
      },
      { status: 201 }
    );
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    if (error instanceof Error && error.message === 'Forbidden') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid input data', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error creating MCP server:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
