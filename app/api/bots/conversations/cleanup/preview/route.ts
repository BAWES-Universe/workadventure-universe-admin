import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/conversations/cleanup/preview
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/bots/conversations/cleanup/preview
 * Preview conversations cleanup (all bots)
 * 
 * Auth: Admin
 * 
 * Query params:
 * - deleteAll: Preview deleting all conversations
 * - olderThanDays: Preview conversations older than X days
 * - maxPerBot: Preview keeping only last N per bot
 * - maxTotal: Preview keeping only last N total
 */
export async function GET(request: NextRequest) {
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

    let where: any = {};
    let cleanupType = '';
    let cleanupValue: number | null = null;

    if (deleteAll) {
      cleanupType = 'deleteAll';
      const totalCount = await prisma.botsConversation.count();
      const botIds = await prisma.botsConversation.findMany({
        select: { botId: true },
        distinct: ['botId'],
      });

      return NextResponse.json(
        {
          cleanupType,
          cleanupValue: null,
          willDelete: {
            conversationCount: totalCount,
            estimatedSizeBytes: totalCount * 5000, // Rough estimate
            oldestToDelete: null,
            newestToDelete: null,
            botsAffected: botIds.length,
          },
          willKeep: {
            conversationCount: 0,
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
      where.endedAt = { lt: cutoffDate };
    } else if (maxPerBot) {
      cleanupType = 'maxPerBot';
      cleanupValue = parseInt(maxPerBot, 10);
      // This is complex - would need to calculate per bot
      // For now, return a simplified preview
      const totalCount = await prisma.botsConversation.count();
      const botIds = await prisma.botsConversation.findMany({
        select: { botId: true },
        distinct: ['botId'],
      });

      return NextResponse.json(
        {
          cleanupType,
          cleanupValue,
          willDelete: {
            conversationCount: Math.max(0, totalCount - (cleanupValue * botIds.length)),
            estimatedSizeBytes: 0, // Would need to calculate
            oldestToDelete: null,
            newestToDelete: null,
            botsAffected: botIds.length,
          },
          willKeep: {
            conversationCount: Math.min(totalCount, cleanupValue * botIds.length),
            oldestKept: null,
            newestKept: null,
          },
          note: 'Preview is approximate. Actual cleanup may vary per bot.',
        },
        { headers: corsHeaders() }
      );
    } else if (maxTotal) {
      cleanupType = 'maxTotal';
      cleanupValue = parseInt(maxTotal, 10);
      const totalCount = await prisma.botsConversation.count();

      if (totalCount > cleanupValue) {
        const keepThreshold = await prisma.botsConversation.findFirst({
          orderBy: { endedAt: 'desc' },
          skip: cleanupValue - 1,
          select: { endedAt: true },
        });

        if (keepThreshold) {
          where.endedAt = { lt: keepThreshold.endedAt };
        }
      } else {
        // Nothing to delete
        return NextResponse.json(
          {
            cleanupType,
            cleanupValue,
            willDelete: {
              conversationCount: 0,
              estimatedSizeBytes: 0,
              oldestToDelete: null,
              newestToDelete: null,
              botsAffected: 0,
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

    const [oldestToDelete, newestToDelete, conversationCount] = await Promise.all([
      prisma.botsConversation.findFirst({
        where,
        orderBy: { endedAt: 'asc' },
        select: { endedAt: true },
      }),
      prisma.botsConversation.findFirst({
        where,
        orderBy: { endedAt: 'desc' },
        select: { endedAt: true },
      }),
      prisma.botsConversation.count({ where }),
    ]);

    const botsAffected = await prisma.botsConversation.findMany({
      where,
      select: { botId: true },
      distinct: ['botId'],
    });

    // Get what will be kept
    const willKeepWhere: any = {};
    if (where.endedAt) {
      willKeepWhere.endedAt = { gte: where.endedAt.lt };
    }

    const [willKeepOldest, willKeepNewest, willKeepCount] = await Promise.all([
      prisma.botsConversation.findFirst({
        where: willKeepWhere,
        orderBy: { endedAt: 'asc' },
        select: { endedAt: true },
      }),
      prisma.botsConversation.findFirst({
        where: willKeepWhere,
        orderBy: { endedAt: 'desc' },
        select: { endedAt: true },
      }),
      prisma.botsConversation.count({ where: willKeepWhere }),
    ]);

    return NextResponse.json(
      {
        cleanupType,
        cleanupValue,
        willDelete: {
          conversationCount,
          estimatedSizeBytes: conversationCount * 5000, // Rough estimate
          oldestToDelete: oldestToDelete?.endedAt.getTime() || null,
          newestToDelete: newestToDelete?.endedAt.getTime() || null,
          botsAffected: botsAffected.length,
        },
        willKeep: {
          conversationCount: willKeepCount,
          oldestKept: willKeepOldest?.endedAt.getTime() || null,
          newestKept: willKeepNewest?.endedAt.getTime() || null,
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

    console.error('Error previewing conversations cleanup:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
