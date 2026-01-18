import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * GET /api/admin/bots/:id
 * Get bot details with usage history (super admin only)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    
    if (!sessionUser || !isSuperAdmin(sessionUser.email)) {
      return NextResponse.json(
        { error: 'Unauthorized: Super admin access required' },
        { status: 403 }
      );
    }

    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    // Fetch bot with relations (bot may not exist if it was deleted, but usage data remains)
    const bot = await prisma.bot.findUnique({
      where: { id },
      include: {
        room: {
          include: {
            world: {
              include: {
                universe: true,
              },
            },
          },
        },
        createdBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
        updatedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    // Build where clause for usage history (always fetch usage, even if bot was deleted)
    const usageWhere: any = {
      botId: id,
    };
    
    if (startDate || endDate) {
      usageWhere.timestamp = {};
      if (startDate) {
        usageWhere.timestamp.gte = new Date(startDate);
      }
      if (endDate) {
        usageWhere.timestamp.lte = new Date(endDate);
      }
    }

    // Calculate usage statistics using aggregation for accurate totals from ALL entries
    // Use try-catch for groupBy as it can fail if there are no matching records
    let usageStats, errorEntries, providerStats, totalCount;
    
    try {
      [usageStats, errorEntries, totalCount] = await Promise.all([
        // Aggregate totals across all entries
        prisma.botsAiUsage.aggregate({
          where: usageWhere,
          _sum: {
            apiCalls: true,
            tokensUsed: true,
            cost: true,
            durationSeconds: true,
          },
        }),
        // Count errors
        prisma.botsAiUsage.findMany({
          where: {
            ...usageWhere,
            error: true,
          },
          select: {
            id: true,
          },
        }),
        // Get total count for pagination
        prisma.botsAiUsage.count({
          where: usageWhere,
        }),
      ]);

      // Group by provider for breakdown (can fail if no records, so handle separately)
      try {
        providerStats = await prisma.botsAiUsage.groupBy({
          by: ['providerId'],
          where: usageWhere,
          _sum: {
            apiCalls: true,
            tokensUsed: true,
            cost: true,
            durationSeconds: true,
          },
        });
      } catch (groupByError) {
        // groupBy fails if there are no matching records, so use empty array
        providerStats = [];
      }
    } catch (aggError) {
      // If aggregation fails, use defaults
      console.error('Error in usage aggregation:', aggError);
      usageStats = { _sum: { apiCalls: null, tokensUsed: null, cost: null, durationSeconds: null } };
      errorEntries = [];
      providerStats = [];
      totalCount = 0;
    }

    // Calculate stats from aggregated data
    const stats = {
      totalCalls: Number(usageStats._sum.apiCalls || 0),
      totalTokens: Number(usageStats._sum.tokensUsed || 0),
      totalCost: usageStats._sum.cost ? Number(usageStats._sum.cost) : 0,
      totalDuration: Number(usageStats._sum.durationSeconds || 0),
      errorCount: errorEntries.length,
      byProvider: {} as Record<string, any>,
    };

    // Get provider details and error counts for each provider
    if (providerStats && providerStats.length > 0) {
      for (const providerStat of providerStats) {
        try {
          const provider = await prisma.aiProvider.findUnique({
            where: { providerId: providerStat.providerId },
            select: { name: true, type: true },
          });

          const providerErrors = await prisma.botsAiUsage.count({
            where: {
              ...usageWhere,
              providerId: providerStat.providerId,
              error: true,
            },
          });

          stats.byProvider[providerStat.providerId] = {
            providerId: providerStat.providerId,
            providerName: provider?.name || providerStat.providerId,
            providerType: provider?.type || 'unknown',
            calls: Number(providerStat._sum?.apiCalls || 0),
            tokens: Number(providerStat._sum?.tokensUsed || 0),
            cost: providerStat._sum?.cost ? Number(providerStat._sum.cost) : 0,
            duration: Number(providerStat._sum?.durationSeconds || 0),
            errors: providerErrors,
          };
        } catch (providerError) {
          console.error(`Error processing provider ${providerStat.providerId}:`, providerError);
          // Continue with other providers even if one fails
        }
      }
    }

    // Fetch usage history (limited to 1000 for display only)
    let usage = [];
    try {
      usage = await prisma.botsAiUsage.findMany({
        where: usageWhere,
        include: {
          provider: {
            select: {
              providerId: true,
              name: true,
              type: true,
            },
          },
        },
        orderBy: {
          timestamp: 'desc',
        },
        take: 1000, // Limit to prevent huge responses - only affects displayed entries
      });
    } catch (usageError) {
      console.error('Error fetching usage history:', usageError);
      // Continue with empty usage array
      usage = [];
    }

    return NextResponse.json({
      bot, // null if bot was deleted
      usage: usage || [],
      stats: stats || {
        totalCalls: 0,
        totalTokens: 0,
        totalCost: 0,
        totalDuration: 0,
        errorCount: 0,
        byProvider: {},
      },
      totalEntries: totalCount || 0, // True total count across all entries
      displayedEntries: usage?.length || 0, // Actually displayed entries (max 1000)
      botExists: bot !== null,
    });
  } catch (error) {
    console.error('Error getting bot details:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

