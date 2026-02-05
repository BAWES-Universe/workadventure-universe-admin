import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/metrics/cleanup
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * DELETE /api/bots/metrics/cleanup
 * Cleanup metrics
 * 
 * Auth: Admin
 * 
 * Query params:
 * - deleteAll: Delete all metrics (true/false)
 * - olderThanDays: Delete metrics older than X days
 * - maxRows: Keep only last N rows per bot
 */
export async function DELETE(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const { searchParams } = new URL(request.url);

    const deleteAll = searchParams.get('deleteAll') === 'true';
    const olderThanDays = searchParams.get('olderThanDays');
    const maxRows = searchParams.get('maxRows');

    if (!deleteAll && !olderThanDays && !maxRows) {
      return NextResponse.json(
        { error: 'Must provide at least one of: deleteAll, olderThanDays, maxRows' },
        { status: 400, headers: corsHeaders() }
      );
    }

    let deletedCount = 0;
    const botsAffected = new Set<string>();

    if (deleteAll) {
      // Delete all metrics
      const totalCount = await prisma.botsMetric.count();
      const botIds = await prisma.botsMetric.findMany({
        select: { botId: true },
        distinct: ['botId'],
      });
      
      botIds.forEach(b => botsAffected.add(b.botId));
      deletedCount = totalCount;

      await prisma.botsMetric.deleteMany({});
    } else if (olderThanDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(olderThanDays, 10));

      const toDelete = await prisma.botsMetric.findMany({
        where: {
          timestamp: { lt: cutoffDate },
        },
        select: { botId: true },
      });

      toDelete.forEach(m => botsAffected.add(m.botId));
      deletedCount = toDelete.length;

      await prisma.botsMetric.deleteMany({
        where: {
          timestamp: { lt: cutoffDate },
        },
      });
    } else if (maxRows) {
      const maxRowsCount = parseInt(maxRows, 10);
      
      // Get all bot IDs
      const botIds = await prisma.botsMetric.findMany({
        select: { botId: true },
        distinct: ['botId'],
      });

      for (const { botId } of botIds) {
        const totalCount = await prisma.botsMetric.count({
          where: { botId },
        });

        if (totalCount > maxRowsCount) {
          // Get the oldest metric we want to keep
          const keepThreshold = await prisma.botsMetric.findFirst({
            where: { botId },
            orderBy: { timestamp: 'desc' },
            skip: maxRowsCount - 1,
            select: { timestamp: true },
          });

          if (keepThreshold) {
            const toDelete = await prisma.botsMetric.findMany({
              where: {
                botId,
                timestamp: { lt: keepThreshold.timestamp },
              },
            });

            deletedCount += toDelete.length;
            botsAffected.add(botId);

            await prisma.botsMetric.deleteMany({
              where: {
                botId,
                timestamp: { lt: keepThreshold.timestamp },
              },
            });
          }
        }
      }
    }

    return NextResponse.json(
      {
        deletedCount,
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

    console.error('Error cleaning up metrics:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
