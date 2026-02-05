import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/test-results/cleanup/preview
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/bots/test-results/cleanup/preview
 * Preview test results cleanup
 * 
 * Auth: Admin
 * 
 * Query params:
 * - deleteAll: Preview deleting all test results
 * - olderThanDays: Preview test results older than X days
 */
export async function GET(request: NextRequest) {
  try {
    await requireAdminAuth(request);

    const { searchParams } = new URL(request.url);

    const deleteAll = searchParams.get('deleteAll') === 'true';
    const olderThanDays = searchParams.get('olderThanDays');

    if (!deleteAll && !olderThanDays) {
      return NextResponse.json(
        { error: 'Must provide either deleteAll or olderThanDays' },
        { status: 400, headers: corsHeaders() }
      );
    }

    let where: any = {};
    let cleanupType = '';
    let cleanupValue: number | null = null;

    if (deleteAll) {
      cleanupType = 'deleteAll';
      const totalCount = await prisma.botsTestResult.count();
      const botIds = await prisma.botsTestResult.findMany({
        where: { botId: { not: null } },
        select: { botId: true },
        distinct: ['botId'],
      });

      return NextResponse.json(
        {
          cleanupType,
          cleanupValue: null,
          willDelete: {
            rowCount: totalCount,
            estimatedSizeBytes: totalCount * 2000, // Rough estimate
            oldestToDelete: null,
            newestToDelete: null,
            botsAffected: botIds.length,
          },
          willKeep: {
            rowCount: 0,
            oldestKept: null,
            newestKept: null,
          },
        },
        { headers: corsHeaders() }
      );
    } else if (olderThanDays) {
      cleanupType = 'olderThanDays';
      cleanupValue = parseInt(olderThanDays, 10);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - cleanupValue);
      where.createdAt = { lt: cutoffDate };
    }

    const [oldestToDelete, newestToDelete, rowCount] = await Promise.all([
      prisma.botsTestResult.findFirst({
        where,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.botsTestResult.findFirst({
        where,
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.botsTestResult.count({ where }),
    ]);

    const botsAffected = await prisma.botsTestResult.findMany({
      where,
      select: { botId: true },
      distinct: ['botId'],
    });

    // Get what will be kept
    const willKeepWhere: any = {};
    if (where.createdAt) {
      willKeepWhere.createdAt = { gte: where.createdAt.lt };
    }

    const [willKeepOldest, willKeepNewest, willKeepCount] = await Promise.all([
      prisma.botsTestResult.findFirst({
        where: willKeepWhere,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      prisma.botsTestResult.findFirst({
        where: willKeepWhere,
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      prisma.botsTestResult.count({ where: willKeepWhere }),
    ]);

    return NextResponse.json(
      {
        cleanupType,
        cleanupValue,
        willDelete: {
          rowCount,
          estimatedSizeBytes: rowCount * 2000, // Rough estimate
          oldestToDelete: oldestToDelete?.createdAt.getTime() || null,
          newestToDelete: newestToDelete?.createdAt.getTime() || null,
          botsAffected: botsAffected.filter(b => b.botId).length,
        },
        willKeep: {
          rowCount: willKeepCount,
          oldestKept: willKeepOldest?.createdAt.getTime() || null,
          newestKept: willKeepNewest?.createdAt.getTime() || null,
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

    console.error('Error previewing test results cleanup:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
