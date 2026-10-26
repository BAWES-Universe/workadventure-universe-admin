import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { addCostRow, emptyCostTotals } from '@/lib/ai-usage-cost';

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

    // The server's own providers only: what people spend on their own keys (#374) costs Universe nothing.
    where.provider = { ownerId: null };

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

    // Get unique bot IDs from usage entries
    const uniqueBotIds = [...new Set(usage.map(entry => entry.botId))];
    
    // Fetch bot names for all unique bot IDs
    const bots = await prisma.bot.findMany({
      where: {
        id: {
          in: uniqueBotIds,
        },
      },
      select: {
        id: true,
        name: true,
      },
    });

    // Create a map of botId -> bot name
    const botNameMap = new Map(bots.map(bot => [bot.id, bot.name]));

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

    // Real prices, old estimates and calls with no price stay apart (game #1173): a flat-rate guess added to a real price tells nothing
    const totals = emptyCostTotals();

    usage.forEach((entry) => {
      stats.totalCalls += entry.apiCalls;
      stats.totalTokens += entry.tokensUsed;
      addCostRow(totals, entry);
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
          ...emptyCostTotals(),
          duration: 0,
          errors: 0,
        };
      }
      stats.byProvider[entry.providerId].calls += entry.apiCalls;
      stats.byProvider[entry.providerId].tokens += entry.tokensUsed;
      addCostRow(stats.byProvider[entry.providerId], entry);
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
          botName: botNameMap.get(entry.botId) || entry.botId, // Fallback to botId if not found
          calls: 0,
          tokens: 0,
          ...emptyCostTotals(),
          duration: 0,
          errors: 0,
        };
      }
      stats.byBot[entry.botId].calls += entry.apiCalls;
      stats.byBot[entry.botId].tokens += entry.tokensUsed;
      addCostRow(stats.byBot[entry.botId], entry);
      if (entry.durationSeconds) {
        stats.byBot[entry.botId].duration += entry.durationSeconds;
      }
      if (entry.error) {
        stats.byBot[entry.botId].errors++;
      }
    });

    stats.totalCost = totals.cost;

    return NextResponse.json({
      usage,
      stats: { ...stats, oldEstimateCost: totals.oldEstimateCost, unknownCalls: totals.unknownCalls },
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

