import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/memory/cleanup
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * DELETE /api/bots/memory/cleanup
 * Cleanup memory data
 * 
 * Auth: Admin
 * 
 * Query params:
 * - deleteAll: Delete all memory (true/false)
 * - olderThanDays: Delete memory older than X days
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
      const totalCount = await prisma.botsMemory.count();
      const botIds = await prisma.botsMemory.findMany({
        select: { botId: true },
        distinct: ['botId'],
      });
      
      botIds.forEach(b => botsAffected.add(b.botId));
      deletedCount = totalCount;

      await prisma.botsMemory.deleteMany({});
    } else if (olderThanDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(olderThanDays, 10));

      const toDelete = await prisma.botsMemory.findMany({
        where: {
          createdAt: { lt: cutoffDate },
        },
        select: { botId: true },
      });

      toDelete.forEach(m => botsAffected.add(m.botId));
      deletedCount = toDelete.length;

      await prisma.botsMemory.deleteMany({
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

    console.error('Error cleaning up memory:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
