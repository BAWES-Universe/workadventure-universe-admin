import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

export const runtime = 'nodejs';

const serverWithBot = Prisma.validator<Prisma.BotMcpServerDefaultArgs>()({
  include: {
    bot: {
      select: {
        id: true,
        name: true,
        createdBy: {
          select: {
            name: true,
            email: true,
          },
        },
      },
    },
  },
});

type ServerWithBot = Prisma.BotMcpServerGetPayload<typeof serverWithBot>;

/**
 * GET /api/admin/mcp-servers
 * List all MCP servers across all bots (super admin only)
 * Supports search, pagination, and enabled filter
 */
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);

    if (!sessionUser || !isSuperAdmin(sessionUser.email)) {
      return NextResponse.json(
        { error: 'Unauthorized: Super admin access required' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
    const skip = (page - 1) * limit;
    const search = searchParams.get('search');
    const enabled = searchParams.get('enabled');

    // Build where clause
    const where: Prisma.BotMcpServerWhereInput = {};

    if (enabled !== null && enabled !== undefined) {
      where.enabled = enabled === 'true';
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: 'insensitive' } },
        { serverUrl: { contains: search, mode: 'insensitive' } },
        {
          bot: {
            name: { contains: search, mode: 'insensitive' },
          },
        },
      ];
    }

    const [servers, total] = await Promise.all([
      prisma.botMcpServer.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          bot: {
            select: {
              id: true,
              name: true,
              createdBy: {
                select: {
                  name: true,
                  email: true,
                },
              },
            },
          },
        },
      }),
      prisma.botMcpServer.count({ where }),
    ]);

    const transformed = servers.map((s: ServerWithBot) => ({
      id: s.id,
      botId: s.botId,
      botName: s.bot.name,
      name: s.name,
      serverUrl: s.serverUrl,
      authType: s.authType,
      enabled: s.enabled,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      botOwner: s.bot.createdBy,
    }));

    return NextResponse.json({
      servers: transformed,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    });
  } catch (error) {
    console.error('Error listing MCP servers:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
