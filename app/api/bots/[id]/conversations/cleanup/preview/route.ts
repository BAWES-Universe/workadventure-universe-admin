import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/:botId/conversations/cleanup/preview
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/bots/:botId/conversations/cleanup/preview
 * Preview what will be deleted before cleanup
 * 
 * Auth: Admin
 * 
 * Query params:
 * - olderThanDays: Preview conversations older than X days
 * - keepRecent: Preview keeping only last N conversations
 */
export async function GET(
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
    let cleanupType = '';
    let cleanupValue: number | null = null;

    if (olderThanDays) {
      cleanupType = 'olderThanDays';
      cleanupValue = parseInt(olderThanDays, 10);
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - cleanupValue);
      where.endedAt = { lt: cutoffDate };
    }

    if (keepRecent) {
      cleanupType = 'keepRecent';
      cleanupValue = parseInt(keepRecent, 10);
      
      // Get total count
      const totalCount = await prisma.botsConversation.count({
        where: { botId },
      });

      if (totalCount > cleanupValue) {
        // Get the oldest conversation we want to keep
        const keepThreshold = await prisma.botsConversation.findFirst({
          where: { botId },
          orderBy: { endedAt: 'desc' },
          skip: cleanupValue - 1,
          select: { endedAt: true },
        });

        if (keepThreshold) {
          where.endedAt = { lt: keepThreshold.endedAt };
        } else {
          // Nothing to delete
          return NextResponse.json(
            {
              botId,
              cleanupType,
              cleanupValue,
              willDelete: {
                conversationCount: 0,
                estimatedSizeBytes: 0,
                oldestToDelete: null,
                newestToDelete: null,
              },
              willKeep: {
                conversationCount: totalCount,
                oldestKept: null,
                newestKept: null,
              },
            },
            { headers: corsHeaders() }
          );
        }
      } else {
        // Nothing to delete
        return NextResponse.json(
          {
            botId,
            cleanupType,
            cleanupValue,
            willDelete: {
              conversationCount: 0,
              estimatedSizeBytes: 0,
              oldestToDelete: null,
              newestToDelete: null,
            },
            willKeep: {
              conversationCount: totalCount,
              oldestKept: null,
              newestKept: null,
            },
          },
          { headers: corsHeaders() }
        );
      }
    }

    // Get what will be deleted
    const toDelete = await prisma.botsConversation.findMany({
      where,
      orderBy: { endedAt: 'asc' },
      select: { endedAt: true, messageCount: true },
    });

    const willDeleteCount = toDelete.length;
    const estimatedSizeBytes = toDelete.reduce((sum, c) => sum + c.messageCount, 0) * 100; // Rough estimate: 100 bytes per message
    const oldestToDelete = toDelete[0]?.endedAt.getTime() || null;
    const newestToDelete = toDelete[toDelete.length - 1]?.endedAt.getTime() || null;

    // Get what will be kept
    const willKeepWhere: any = { botId };
    if (where.endedAt) {
      willKeepWhere.endedAt = { gte: where.endedAt.lt };
    }

    const willKeep = await prisma.botsConversation.findMany({
      where: willKeepWhere,
      orderBy: { endedAt: 'asc' },
      select: { endedAt: true },
    });

    const willKeepCount = willKeep.length;
    const oldestKept = willKeep[0]?.endedAt.getTime() || null;
    const newestKept = willKeep[willKeep.length - 1]?.endedAt.getTime() || null;

    return NextResponse.json(
      {
        botId,
        cleanupType,
        cleanupValue,
        willDelete: {
          conversationCount: willDeleteCount,
          estimatedSizeBytes,
          oldestToDelete,
          newestToDelete,
        },
        willKeep: {
          conversationCount: willKeepCount,
          oldestKept,
          newestKept,
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

    console.error('Error previewing cleanup:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
