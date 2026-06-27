import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminSession } from '@/lib/auth';
import { isSuperAdmin } from '@/lib/super-admin';
import { encryptApiKey, decryptApiKey } from '@/lib/encryption';
import { z } from 'zod';

export const runtime = 'nodejs';

// Validation schema for updating an MCP server (all fields optional)
const updateMcpServerSchema = z.object({
  name: z.string().min(1, 'name cannot be empty').max(255).optional(),
  serverUrl: z.string().url('serverUrl must be a valid URL').optional(),
  authType: z.enum(['none', 'bearer', 'api-key']).optional(),
  authConfig: z.string().optional().nullable(),
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
 * PATCH /api/bots/[botId]/mcp-servers/[id]
 * Update an MCP server. Re-encrypts authConfig if changed.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ botId: string; id: string }> }
) {
  try {
    const { botId, id } = await params;

    const actor = await requireAdminSession();
    await getAuthorizedBot(botId, actor.userId);

    // Fetch existing server
    const existing = await prisma.botMcpServer.findUnique({
      where: { id },
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
    if (validatedData.authType !== undefined) updateData.authType = validatedData.authType;
    if (validatedData.enabled !== undefined) updateData.enabled = validatedData.enabled;

    // Handle authConfig: if changed, re-encrypt
    if (validatedData.authConfig !== undefined) {
      if (validatedData.authConfig === null || validatedData.authConfig === '') {
        updateData.authConfig = null;
      } else {
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
    }

    const updated = await prisma.botMcpServer.update({
      where: { id },
      data: updateData,
    });

    return NextResponse.json({
      id: updated.id,
      botId: updated.botId,
      name: updated.name,
      serverUrl: updated.serverUrl,
      authType: updated.authType,
      enabled: updated.enabled,
      createdAt: updated.createdAt,
      updatedAt: updated.updatedAt,
    });
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
 * DELETE /api/bots/[botId]/mcp-servers/[id]
 * Delete an MCP server. Returns 204.
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ botId: string; id: string }> }
) {
  try {
    const { botId, id } = await params;

    const actor = await requireAdminSession();
    await getAuthorizedBot(botId, actor.userId);

    // Fetch existing server to verify ownership
    const existing = await prisma.botMcpServer.findUnique({
      where: { id },
    });

    if (!existing || existing.botId !== botId) {
      return NextResponse.json({ error: 'MCP server not found' }, { status: 404 });
    }

    await prisma.botMcpServer.delete({
      where: { id },
    });

    return new NextResponse(null, { status: 204 });
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
