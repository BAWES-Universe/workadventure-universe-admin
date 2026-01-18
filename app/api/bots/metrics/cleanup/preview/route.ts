import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/metrics/cleanup/preview
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/bots/metrics/cleanup/preview
 * Preview metrics cleanup
 * 
 * Auth: Admin
 * 
 * Query params:
 * - olderThanDays: Preview metrics older than X days
 * - maxRows: Preview keeping only last N rows per bot
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const { searchParams } = new URL(request.url);

    const olderThanDays = searchParams.get('olderThanDays');
    const maxRows = searchParams.get('maxRows');

    if (!olderThanDays && !maxRows) {
      return NextResponse.json(
        { error: 'Must provide either olderThanDays or maxRows' },
        { status: 400, headers: corsHeaders() }
      );
    }

    let where: any = {};
    let cleanupType = '';
    let cleanupValue: number | null = null;

    if (olderThanDays) {
      cleanupType = 'olderThanDays';
      cleanupValue = parseInt(olderThanDays, 10);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - cleanupValue);
      where.timestamp = { lt: cutoffDate };
    }

    if (maxRows) {
      cleanupType = 'maxRows';
      cleanupValue = parseInt(maxRows, 10);
      
      // This is complex - would need to calculate per bot
      // For now, return a simplified preview
      const totalCount = await prisma.botsMetric.count();
      const botCount = await prisma.botsMetric.findMany({
        select: { botId: true },
        distinct: ['botId'],
      });

      return NextResponse.json(
        {
          cleanupType,
          cleanupValue,
          willDelete: {
            metricCount: Math.max(0, totalCount - (cleanupValue * botCount.length)),
            estimatedSizeBytes: 0, // Would need to calculate
            oldestToDelete: null,
            newestToDelete: null,
            botsAffected: botCount.length,
          },
          willKeep: {
            metricCount: Math.min(totalCount, cleanupValue * botCount.length),
            oldestKept: null,
            newestKept: null,
          },
          note: 'Preview is approximate. Actual cleanup may vary per bot.',
        },
        { headers: corsHeaders() }
      );
    }

    // Get what will be deleted
    const toDelete = await prisma.botsMetric.findMany({
      where,
      orderBy: { timestamp: 'asc' },
      select: { timestamp: true },
      take: 1,
    });

    const [oldestToDelete, newestToDelete, metricCount] = await Promise.all([
      prisma.botsMetric.findFirst({
        where,
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },
      }),
      prisma.botsMetric.findFirst({
        where,
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true },
      }),
      prisma.botsMetric.count({ where }),
    ]);

    const botsAffected = await prisma.botsMetric.findMany({
      where,
      select: { botId: true },
      distinct: ['botId'],
    });

    // Get what will be kept
    const willKeepWhere: any = {};
    if (where.timestamp) {
      willKeepWhere.timestamp = { gte: where.timestamp.lt };
    }

    const [willKeepOldest, willKeepNewest, willKeepCount] = await Promise.all([
      prisma.botsMetric.findFirst({
        where: willKeepWhere,
        orderBy: { timestamp: 'asc' },
        select: { timestamp: true },
      }),
      prisma.botsMetric.findFirst({
        where: willKeepWhere,
        orderBy: { timestamp: 'desc' },
        select: { timestamp: true },
      }),
      prisma.botsMetric.count({ where: willKeepWhere }),
    ]);

    return NextResponse.json(
      {
        cleanupType,
        cleanupValue,
        willDelete: {
          metricCount,
          estimatedSizeBytes: metricCount * 100, // Rough estimate
          oldestToDelete: oldestToDelete?.timestamp.getTime() || null,
          newestToDelete: newestToDelete?.timestamp.getTime() || null,
          botsAffected: botsAffected.length,
        },
        willKeep: {
          metricCount: willKeepCount,
          oldestKept: willKeepOldest?.timestamp.getTime() || null,
          newestKept: willKeepNewest?.timestamp.getTime() || null,
        },
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

    console.error('Error previewing metrics cleanup:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
