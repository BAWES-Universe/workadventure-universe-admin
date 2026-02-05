import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireAdminAuth } from '@/lib/admin-auth';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * GET /api/bots/:id/metrics/stats
 * Get aggregated metrics statistics (bypasses grouping, uses raw rows)
 * 
 * Auth: Admin (session or admin token)
 * 
 * Query params:
 * - startTime: Start timestamp (milliseconds)
 * - endTime: End timestamp (milliseconds)
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await requireAdminAuth(request);

    const { id: botId } = await params;
    const { searchParams } = new URL(request.url);

    // Parse query params
    const startTime = searchParams.get('startTime');
    const endTime = searchParams.get('endTime');

    // Build where clause
    const where: any = {
      botId,
    };

    if (startTime || endTime) {
      where.timestamp = {};
      if (startTime) {
        where.timestamp.gte = new Date(parseInt(startTime, 10));
      }
      if (endTime) {
        where.timestamp.lte = new Date(parseInt(endTime, 10));
      }
    }

    // Query all metric rows for this bot (no grouping, no limit)
    const allRows = await prisma.botsMetric.findMany({
      where,
      select: {
        metricType: true,
        metricValue: true,
      },
    });

    // Aggregate across all rows
    let totalResponseTime = 0;
    let responseTimeCount = 0;
    let totalTokens = 0;
    let totalErrors = 0;
    let totalRepetition = 0;
    let repetitionCount = 0;
    
    // Track which metric types are available
    const metricTypes = new Set<string>();
    for (const row of allRows) {
      metricTypes.add(row.metricType);
      
      switch (row.metricType) {
        case 'response_time':
          totalResponseTime += Number(row.metricValue);
          responseTimeCount++;
          break;
        case 'token_usage_total':
          totalTokens += Number(row.metricValue);
          break;
        case 'error_count':
          totalErrors += Number(row.metricValue);
          break;
        case 'repetition_score':
          totalRepetition += Number(row.metricValue);
          repetitionCount++;
          break;
      }
    }

    const avgResponseTime = responseTimeCount > 0 ? totalResponseTime / responseTimeCount : 0;
    const avgRepetition = repetitionCount > 0 ? totalRepetition / repetitionCount : 0;

    return NextResponse.json({
      avgResponseTime,
      totalTokens,
      totalErrors,
      avgRepetition,
      responseTimeCount,
      repetitionCount,
      totalRows: allRows.length,
      availableMetricTypes: Array.from(metricTypes),
    }, { headers: corsHeaders() });
  } catch (error: any) {
    if (error.message === 'Unauthorized: Admin authentication required') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error getting metrics stats:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
