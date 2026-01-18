import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/:botId/conversations/cleanup
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * DELETE /api/bots/:botId/conversations/cleanup
 * Cleanup conversations
 * 
 * Auth: Admin
 * 
 * Query params:
 * - olderThanDays: Delete conversations older than X days
 * - keepRecent: Keep only last N conversations
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdminAuth(request);

    const { id: botId } = await params;
    const { searchParams } = new URL(request.url);

    const olderThanDays = searchParams.get('olderThanDays');
    const keepRecent = searchParams.get('keepRecent');

    if (!olderThanDays && !keepRecent) {
      return NextResponse.json(
        { error: 'Must provide either olderThanDays or keepRecent' },
        { status: 400, headers: corsHeaders() }
      );
    }

    let where: any = { botId };
    let deletedCount = 0;

    if (olderThanDays) {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - parseInt(olderThanDays, 10));
      where.endedAt = { lt: cutoffDate };
    }

    if (keepRecent) {
      // Get total count
      const totalCount = await prisma.botsConversation.count({
        where: { botId },
      });

      const keepCount = parseInt(keepRecent, 10);
      if (totalCount > keepCount) {
        // Get the oldest conversation we want to keep
        const keepThreshold = await prisma.botsConversation.findFirst({
          where: { botId },
          orderBy: { endedAt: 'desc' },
          skip: keepCount - 1,
          select: { endedAt: true },
        });

        if (keepThreshold) {
          where.endedAt = { lt: keepThreshold.endedAt };
        }
      } else {
        // Nothing to delete
        return NextResponse.json(
          {
            deletedCount: 0,
            spaceFreed: 0,
            botsAffected: 1,
          },
          { headers: corsHeaders() }
        );
      }
    }

    // Count what will be deleted
    const toDelete = await prisma.botsConversation.findMany({
      where,
      select: { id: true, messageCount: true },
    });

    deletedCount = toDelete.length;
    const spaceFreed = toDelete.reduce((sum, c) => sum + c.messageCount, 0);

    // Delete conversations
    await prisma.botsConversation.deleteMany({
      where,
    });

    return NextResponse.json(
      {
        deletedCount,
        spaceFreed,
        botsAffected: 1,
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

    console.error('Error cleaning up conversations:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
