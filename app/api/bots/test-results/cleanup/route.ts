import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/test-results/cleanup
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * DELETE /api/bots/test-results/cleanup
 * Cleanup test results
 * 
 * Auth: Admin
 * 
 * Query params:
 * - deleteAll: Delete all test results (true/false)
 * - olderThanDays: Delete test results older than X days
 */
export async function DELETE(request: NextRequest) {
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

    let deletedCount = 0;
    const botsAffected = new Set<string>();

    if (deleteAll) {
      const totalCount = await prisma.botsTestResult.count();
      const botIds = await prisma.botsTestResult.findMany({
        where: { botId: { not: null } },
        select: { botId: true },
        distinct: ['botId'],
      });
      
      botIds.forEach(b => b.botId && botsAffected.add(b.botId));
      deletedCount = totalCount;

      await prisma.botsTestResult.deleteMany({});
    } else if (olderThanDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(olderThanDays, 10));

      const toDelete = await prisma.botsTestResult.findMany({
        where: {
          createdAt: { lt: cutoffDate },
        },
        select: { botId: true },
      });

      toDelete.forEach(m => m.botId && botsAffected.add(m.botId));
      deletedCount = toDelete.length;

      await prisma.botsTestResult.deleteMany({
        where: {
          createdAt: { lt: cutoffDate },
        },
      });
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

    console.error('Error cleaning up test results:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
