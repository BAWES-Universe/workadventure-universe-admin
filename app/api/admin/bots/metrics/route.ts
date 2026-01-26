import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';

/**
 * GET /api/admin/bots/metrics
 * Browse metrics grouped by response with summary statistics (super admin only)
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
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '50', 10)));

    // Filters
    const botId = searchParams.get('botId');
    const startDate = searchParams.get('startDate');
    const endDate = searchParams.get('endDate');

    // Build where clause
    const where: any = {};

    if (botId) {
      where.botId = botId;
    }

    if (startDate || endDate) {
      where.timestamp = {};
      if (startDate) {
        where.timestamp.gte = new Date(startDate);
      }
      if (endDate) {
        where.timestamp.lte = new Date(endDate);
      }
    }

    // Fetch all metrics for the time range (we'll group them)
    const allMetrics = await prisma.botsMetric.findMany({
      where,
      orderBy: { timestamp: 'desc' },
    });

    // Group metrics by responseId (from metadata) or timestamp
    const groupedMap = new Map<string, {
      responseId: string | null;
      timestamp: Date;
      botId: string;
      metadata: any;
      metrics: {
        responseTime?: number;
        repetitionScore?: number;
        conversationQuality?: number;
        personalityCompliance?: number;
        systemPromptLeakage?: boolean;
        errorCount?: number;
        tokenUsage?: {
          prompt?: number;
          completion?: number;
          total?: number;
        };
      };
    }>();

    for (const metric of allMetrics) {
      const metadata = metric.metadata as any || {};
      // Use responseId from metadata, or fall back to timestamp-based grouping
      const responseId = metadata.responseId || `timestamp_${metric.timestamp.getTime()}`;
      const groupKey = `${metric.botId}_${responseId}`;

      if (!groupedMap.has(groupKey)) {
        groupedMap.set(groupKey, {
          responseId: metadata.responseId || null,
          timestamp: metric.timestamp,
          botId: metric.botId,
          metadata: metadata,
          metrics: {},
        });
      }

      const group = groupedMap.get(groupKey)!;

      // Map metric types to grouped structure
      switch (metric.metricType) {
        case 'response_time':
          group.metrics.responseTime = Number(metric.metricValue);
          break;
        case 'repetition_score':
          group.metrics.repetitionScore = Number(metric.metricValue);
          break;
        case 'conversation_quality':
          group.metrics.conversationQuality = Number(metric.metricValue);
          break;
        case 'personality_compliance':
          group.metrics.personalityCompliance = Number(metric.metricValue);
          break;
        case 'system_prompt_leakage':
          group.metrics.systemPromptLeakage = Number(metric.metricValue) === 1;
          break;
        case 'error_count':
          group.metrics.errorCount = Number(metric.metricValue);
          break;
        case 'token_usage_prompt':
          if (!group.metrics.tokenUsage) group.metrics.tokenUsage = {};
          group.metrics.tokenUsage.prompt = Number(metric.metricValue);
          break;
        case 'token_usage_completion':
          if (!group.metrics.tokenUsage) group.metrics.tokenUsage = {};
          group.metrics.tokenUsage.completion = Number(metric.metricValue);
          break;
        case 'token_usage_total':
          if (!group.metrics.tokenUsage) group.metrics.tokenUsage = {};
          group.metrics.tokenUsage.total = Number(metric.metricValue);
          break;
      }
    }

    // Convert to array and sort by timestamp
    const groupedResponses = Array.from(groupedMap.values())
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Calculate summary statistics
    const responseTimes = groupedResponses
      .map(r => r.metrics.responseTime)
      .filter((v): v is number => v !== undefined);
    const qualities = groupedResponses
      .map(r => r.metrics.conversationQuality)
      .filter((v): v is number => v !== undefined);
    const repetitions = groupedResponses
      .map(r => r.metrics.repetitionScore)
      .filter((v): v is number => v !== undefined);
    const compliances = groupedResponses
      .map(r => r.metrics.personalityCompliance)
      .filter((v): v is number => v !== undefined);

    const avgResponseTime = responseTimes.length > 0
      ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
      : 0;
    const avgQuality = qualities.length > 0
      ? qualities.reduce((a, b) => a + b, 0) / qualities.length
      : 0;
    const avgRepetition = repetitions.length > 0
      ? repetitions.reduce((a, b) => a + b, 0) / repetitions.length
      : 0;
    const avgCompliance = compliances.length > 0
      ? compliances.reduce((a, b) => a + b, 0) / compliances.length
      : 0;

    // Calculate P95 response time
    const sortedResponseTimes = [...responseTimes].sort((a, b) => a - b);
    const p95Index = Math.floor(sortedResponseTimes.length * 0.95);
    const p95ResponseTime = sortedResponseTimes[p95Index] || 0;

    // Count issues
    const issues = groupedResponses.filter(r => {
      const hasHighRepetition = (r.metrics.repetitionScore || 0) > 0.2;
      const hasLowQuality = (r.metrics.conversationQuality || 1) < 0.8;
      const hasLeakage = r.metrics.systemPromptLeakage === true;
      const hasErrors = (r.metrics.errorCount || 0) > 0;
      return hasHighRepetition || hasLowQuality || hasLeakage || hasErrors;
    }).length;

    // Paginate grouped responses
    const skip = (page - 1) * limit;
    const paginatedResponses = groupedResponses.slice(skip, skip + limit);
    const total = groupedResponses.length;
    const totalPages = Math.ceil(total / limit);

    return NextResponse.json({
      responses: paginatedResponses,
      summary: {
        totalResponses: total,
        avgResponseTime: Math.round(avgResponseTime),
        avgQuality: Number(avgQuality.toFixed(3)),
        avgRepetition: Number(avgRepetition.toFixed(3)),
        avgCompliance: Number(avgCompliance.toFixed(3)),
        p95ResponseTime: Math.round(p95ResponseTime),
        issuesDetected: issues,
        personalityCompliance: compliances.length > 0
          ? `${Math.round((compliances.filter(c => c >= 0.95).length / compliances.length) * 100)}%`
          : '0%',
      },
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
    });
  } catch (error) {
    console.error('Error listing metrics:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
