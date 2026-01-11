import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * GET /api/admin/ai-providers/usage
 * Get usage analytics (super admin only)
 * 
 * Query params:
 * - startDate: ISO date string
 * - endDate: ISO date string
 * - providerId: filter by provider
 * - botId: filter by bot
 */
export async function GET(request: NextRequest) {
  try {
    const sessionUser = await getSessionUser(request);
    
    if (!sessionUser || !isSuperAdmin(sessionUser.email)) {
      return NextResponse.json(
        { error: 'Unauthorized: Super admin access required' },
        { status: 403 }
      );
    }

    const { searchParams } = new URL(request.url);
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');
    const providerId = searchParams.get('providerId');
    const botId = searchParams.get('botId');

    // Build where clause
    const where: any = {};
    
    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) {
        where.timestamp.gte = new Date(startDate);
      }
      if (endDate) {
        where.timestamp.lte = new Date(endDate);
      }
    }

    if (providerId) {
      where.providerId = providerId;
    }

    if (botId) {
      where.botId = botId;
    }

    // Get usage data
    const usage = await prisma.botsAiUsage.findMany({
      where,
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
      take: 1000, // Limit to prevent huge responses
    });

    // Aggregate statistics
    const stats = {
      totalCalls: 0,
      totalTokens: 0,
      totalCost: 0,
      totalDuration: 0,
      errorCount: 0,
      byProvider: {} as Record<string, any>,
      byBot: {} as Record<string, any>,
    };

    usage.forEach((entry) => {
      stats.totalCalls += entry.apiCalls;
      stats.totalTokens += entry.tokensUsed;
      if (entry.cost) {
        stats.totalCost += Number(entry.cost);
      }
      if (entry.durationSeconds) {
        stats.totalDuration += entry.durationSeconds;
      }
      if (entry.error) {
        stats.errorCount++;
      }

      // By provider
      if (!stats.byProvider[entry.providerId]) {
        stats.byProvider[entry.providerId] = {
          providerId: entry.providerId,
          providerName: entry.provider.name,
          providerType: entry.provider.type,
          calls: 0,
          tokens: 0,
          cost: 0,
          duration: 0,
          errors: 0,
        };
      }
      stats.byProvider[entry.providerId].calls += entry.apiCalls;
      stats.byProvider[entry.providerId].tokens += entry.tokensUsed;
      if (entry.cost) {
        stats.byProvider[entry.providerId].cost += Number(entry.cost);
      }
      if (entry.durationSeconds) {
        stats.byProvider[entry.providerId].duration += entry.durationSeconds;
      }
      if (entry.error) {
        stats.byProvider[entry.providerId].errors++;
      }

      // By bot
      if (!stats.byBot[entry.botId]) {
        stats.byBot[entry.botId] = {
          botId: entry.botId,
          calls: 0,
          tokens: 0,
          cost: 0,
          duration: 0,
          errors: 0,
        };
      }
      stats.byBot[entry.botId].calls += entry.apiCalls;
      stats.byBot[entry.botId].tokens += entry.tokensUsed;
      if (entry.cost) {
        stats.byBot[entry.botId].cost += Number(entry.cost);
      }
      if (entry.durationSeconds) {
        stats.byBot[entry.botId].duration += entry.durationSeconds;
      }
      if (entry.error) {
        stats.byBot[entry.botId].errors++;
      }
    });

    return NextResponse.json({
      usage,
      stats,
      totalEntries: usage.length,
    });
  } catch (error) {
    console.error('Error getting usage analytics:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

