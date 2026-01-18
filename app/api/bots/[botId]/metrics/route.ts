import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/:botId/metrics
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * GET /api/bots/:botId/metrics
 * Query metrics with filters
 * 
 * Auth: BOT_SERVICE_TOKEN
 * 
 * Query params:
 * - metricType: Filter by metric type
 * - startTime: Start timestamp (milliseconds)
 * - endTime: End timestamp (milliseconds)
 * - limit: Maximum results (default: 100)
 * - offset: Pagination offset
 * 
 * Response: Reconstructed nested format
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ botId: string }> }
) {
  try {
    requireServiceToken(request);

    const { botId } = await params;
    const { searchParams } = new URL(request.url);

    // Parse query params
    const metricType = searchParams.get('metricType');
    const startTime = searchParams.get('startTime');
    const endTime = searchParams.get('endTime');
    const limit = Math.min(parseInt(searchParams.get('limit') || '100', 10), 1000); // Max 1000
    const offset = parseInt(searchParams.get('offset') || '0', 10);

    // Build where clause
    const where: any = {
      botId,
    };

    if (metricType) {
      where.metricType = metricType;
    }

    if (startTime || endTime) {
      where.timestamp = {};
      if (startTime) {
        where.timestamp.gte = new Date(parseInt(startTime, 10));
      }
      if (endTime) {
        where.timestamp.lte = new Date(parseInt(endTime, 10));
      }
    }

    // Query flattened rows
    const rows = await prisma.botsMetric.findMany({
      where,
      orderBy: { timestamp: 'desc' },
      take: limit * 10, // Get more rows to account for grouping
      skip: offset * 10, // Approximate offset
    });

    // Group rows by (botId, timestamp) and reconstruct nested format
    const grouped = new Map<string, {
      botId: string;
      timestamp: number;
      metrics: Record<string, any>;
      metadata?: Record<string, any>;
    }>();

    for (const row of rows) {
      const key = `${row.botId}_${row.timestamp.getTime()}`;
      
      if (!grouped.has(key)) {
        grouped.set(key, {
          botId: row.botId,
          timestamp: row.timestamp.getTime(), // Convert to milliseconds
          metrics: {},
          metadata: row.metadata as Record<string, any> | undefined,
        });
      }

      const group = grouped.get(key)!;

      // Map metric types back to nested keys
      switch (row.metricType) {
        case 'response_time':
          group.metrics.responseTime = Number(row.metricValue);
          break;
        case 'repetition_score':
          group.metrics.repetitionScore = Number(row.metricValue);
          break;
        case 'personality_compliance':
          group.metrics.personalityCompliance = Number(row.metricValue);
          break;
        case 'conversation_quality':
          group.metrics.conversationQuality = Number(row.metricValue);
          break;
        case 'error_count':
          group.metrics.errorCount = Number(row.metricValue);
          break;
        case 'system_prompt_leakage':
          group.metrics.systemPromptLeakage = Number(row.metricValue) === 1; // Convert back to boolean
          break;
        case 'token_usage_prompt':
          if (!group.metrics.tokenUsage) {
            group.metrics.tokenUsage = {};
          }
          group.metrics.tokenUsage.prompt = Number(row.metricValue);
          break;
        case 'token_usage_completion':
          if (!group.metrics.tokenUsage) {
            group.metrics.tokenUsage = {};
          }
          group.metrics.tokenUsage.completion = Number(row.metricValue);
          break;
        case 'token_usage_total':
          if (!group.metrics.tokenUsage) {
            group.metrics.tokenUsage = {};
          }
          group.metrics.tokenUsage.total = Number(row.metricValue);
          break;
      }
    }

    // Convert map to array and apply pagination
    const result = Array.from(grouped.values())
      .sort((a, b) => b.timestamp - a.timestamp) // Sort by timestamp descending
      .slice(0, limit);

    return NextResponse.json(result, { headers: corsHeaders() });
  } catch (error: any) {
    if (error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error querying metrics:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
