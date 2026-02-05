import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/conversations/cleanup
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * DELETE /api/bots/conversations/cleanup
 * Cleanup all conversations across all bots
 * 
 * Auth: Admin
 * 
 * Query params:
 * - olderThanDays: Delete conversations older than X days
 * - maxPerBot: Maximum conversations per bot
 * - maxTotal: Maximum total conversations
 */
export async function DELETE(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const { searchParams } = new URL(request.url);

    const deleteAll = searchParams.get('deleteAll') === 'true';
    const olderThanDays = searchParams.get('olderThanDays');
    const maxPerBot = searchParams.get('maxPerBot');
    const maxTotal = searchParams.get('maxTotal');

    if (!deleteAll && !olderThanDays && !maxPerBot && !maxTotal) {
      return NextResponse.json(
        { error: 'Must provide at least one of: deleteAll, olderThanDays, maxPerBot, maxTotal' },
        { status: 400, headers: corsHeaders() }
      );
    }

    let deletedCount = 0;
    let spaceFreed = 0;
    const botsAffected = new Set<string>();

    if (deleteAll) {
      // Delete all conversations
      const totalCount = await prisma.botsConversation.count();
      const botIds = await prisma.botsConversation.findMany({
        select: { botId: true },
        distinct: ['botId'],
      });
      
      botIds.forEach(b => botsAffected.add(b.botId));
      deletedCount = totalCount;

      await prisma.botsConversation.deleteMany({});
    } else if (olderThanDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(olderThanDays, 10));

      const toDelete = await prisma.botsConversation.findMany({
        where: {
          endedAt: { lt: cutoffDate },
        },
        select: { id: true, botId: true, messageCount: true },
      });

      for (const conv of toDelete) {
        botsAffected.add(conv.botId);
        spaceFreed += conv.messageCount;
      }

      deletedCount = toDelete.length;

      await prisma.botsConversation.deleteMany({
        where: {
          endedAt: { lt: cutoffDate },
        },
      });
    }

    if (maxPerBot) {
      const maxPerBotCount = parseInt(maxPerBot, 10);
      
      // Get all bot IDs
      const botIds = await prisma.botsConversation.findMany({
        select: { botId: true },
        distinct: ['botId'],
      });

      for (const { botId } of botIds) {
        const totalCount = await prisma.botsConversation.count({
          where: { botId },
        });

        if (totalCount > maxPerBotCount) {
          // Get the oldest conversation we want to keep
          const keepThreshold = await prisma.botsConversation.findFirst({
            where: { botId },
            orderBy: { endedAt: 'desc' },
            skip: maxPerBotCount - 1,
            select: { endedAt: true },
          });

          if (keepThreshold) {
            const toDelete = await prisma.botsConversation.findMany({
              where: {
                botId,
                endedAt: { lt: keepThreshold.endedAt },
              },
              select: { id: true, messageCount: true },
            });

            deletedCount += toDelete.length;
            spaceFreed += toDelete.reduce((sum, c) => sum + c.messageCount, 0);
            botsAffected.add(botId);

            await prisma.botsConversation.deleteMany({
              where: {
                botId,
                endedAt: { lt: keepThreshold.endedAt },
              },
            });
          }
        }
      }
    }

    if (maxTotal) {
      const maxTotalCount = parseInt(maxTotal, 10);
      const totalCount = await prisma.botsConversation.count();

      if (totalCount > maxTotalCount) {
        // Get the oldest conversation we want to keep
        const keepThreshold = await prisma.botsConversation.findFirst({
          orderBy: { endedAt: 'desc' },
          skip: maxTotalCount - 1,
          select: { endedAt: true },
        });

        if (keepThreshold) {
          const toDelete = await prisma.botsConversation.findMany({
            where: {
              endedAt: { lt: keepThreshold.endedAt },
            },
            select: { id: true, botId: true, messageCount: true },
          });

          deletedCount += toDelete.length;
          spaceFreed += toDelete.reduce((sum, c) => sum + c.messageCount, 0);
          toDelete.forEach(c => botsAffected.add(c.botId));

          await prisma.botsConversation.deleteMany({
            where: {
              endedAt: { lt: keepThreshold.endedAt },
            },
          });
        }
      }
    }

    return NextResponse.json(
      {
        deletedCount,
        spaceFreed,
        botsAffected: botsAffected.size,
      },
      { headers: corsHeaders() }
    );
  } catch (error: any) {
    if (error.message === 'Unauthorized: Admin authentication required') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error cleaning up all conversations:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
