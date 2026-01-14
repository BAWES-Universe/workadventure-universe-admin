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

    // Fetch usage history
    const usage = await prisma.botsAiUsage.findMany({
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
      take: 1000, // Limit to prevent huge responses
    });

    // Calculate usage statistics
    const stats = {
      totalCalls: 0,
      totalTokens: 0,
      totalCost: 0,
      totalDuration: 0,
      errorCount: 0,
      byProvider: {} as Record<string, any>,
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
    });

    return NextResponse.json({
      bot, // null if bot was deleted
      usage,
      stats,
      totalEntries: usage.length,
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

