import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/metrics
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * POST /api/bots/metrics
 * Store bot metrics (batch writes)
 * 
 * Auth: BOT_SERVICE_TOKEN
 * Fire-and-forget (non-blocking)
 * 
 * Request body:
 * {
 *   "metrics": [
 *     {
 *       "botId": "bot-123",
 *       "timestamp": 1704067200000,
 *       "metrics": {
 *         "responseTime": 1250,
 *         "tokenUsage": { "prompt": 500, "completion": 200, "total": 700 },
 *         "repetitionScore": 0.1,
 *         "systemPromptLeakage": false,
 *         "personalityCompliance": 0.95,
 *         "errorCount": 2
 *       },
 *       "metadata": { "playerId": 123 }
 *     }
 *   ]
 * }
 * 
 * Metrics are flattened: each field in the nested metrics object becomes a separate row
 */
export async function POST(request: NextRequest) {
  try {
    // Require service token
    requireServiceToken(request);

    const body = await request.json();
    const { metrics } = body;

    if (!Array.isArray(metrics)) {
      return NextResponse.json(
        { error: 'metrics must be an array' },
        { status: 400, headers: corsHeaders() }
      );
    }

    // Flatten metrics: each nested metric becomes a separate row
    const rowsToInsert: Array<{
      botId: string;
      metricType: string;
      metricValue: number;
      metadata: any;
      timestamp: Date;
    }> = [];

    for (const metric of metrics) {
      if (!metric.botId || !metric.timestamp || !metric.metrics) {
        console.warn('Skipping invalid metric:', { botId: metric.botId, hasTimestamp: !!metric.timestamp, hasMetrics: !!metric.metrics });
        continue; // Skip invalid metrics
      }

      const timestamp = new Date(metric.timestamp);
      const metadata = metric.metadata || {};

      // Flatten nested metrics object
      const metricsObj = metric.metrics;

      // Debug: log what we received
      const receivedFields = Object.keys(metricsObj);
      console.log(`Processing metric for bot ${metric.botId}, received fields:`, receivedFields);

      // Simple metrics: direct mapping
      // Use != null to check for both undefined and null
      if (metricsObj.responseTime != null) {
        rowsToInsert.push({
          botId: metric.botId,
          metricType: 'response_time',
          metricValue: Number(metricsObj.responseTime),
          metadata,
          timestamp,
        });
      }

      if (metricsObj.repetitionScore != null) {
        rowsToInsert.push({
          botId: metric.botId,
          metricType: 'repetition_score',
          metricValue: Number(metricsObj.repetitionScore),
          metadata,
          timestamp,
        });
      }

      if (metricsObj.personalityCompliance != null) {
        rowsToInsert.push({
          botId: metric.botId,
          metricType: 'personality_compliance',
          metricValue: Number(metricsObj.personalityCompliance),
          metadata,
          timestamp,
        });
      }

      if (metricsObj.conversationQuality != null) {
        rowsToInsert.push({
          botId: metric.botId,
          metricType: 'conversation_quality',
          metricValue: Number(metricsObj.conversationQuality),
          metadata,
          timestamp,
        });
      }

      if (metricsObj.errorCount != null) {
        rowsToInsert.push({
          botId: metric.botId,
          metricType: 'error_count',
          metricValue: Number(metricsObj.errorCount),
          metadata,
          timestamp,
        });
      }

      // Token usage: separate rows (Option A)
      if (metricsObj.tokenUsage && typeof metricsObj.tokenUsage === 'object') {
        if (metricsObj.tokenUsage.prompt != null) {
          rowsToInsert.push({
            botId: metric.botId,
            metricType: 'token_usage_prompt',
            metricValue: Number(metricsObj.tokenUsage.prompt),
            metadata,
            timestamp,
          });
        }

        if (metricsObj.tokenUsage.completion != null) {
          rowsToInsert.push({
            botId: metric.botId,
            metricType: 'token_usage_completion',
            metricValue: Number(metricsObj.tokenUsage.completion),
            metadata,
            timestamp,
          });
        }

        if (metricsObj.tokenUsage.total != null) {
          rowsToInsert.push({
            botId: metric.botId,
            metricType: 'token_usage_total',
            metricValue: Number(metricsObj.tokenUsage.total),
            metadata,
            timestamp,
          });
        }
      }

      // Boolean metrics: convert to numeric (0/1)
      if (metricsObj.systemPromptLeakage != null) {
        rowsToInsert.push({
          botId: metric.botId,
          metricType: 'system_prompt_leakage',
          metricValue: metricsObj.systemPromptLeakage ? 1 : 0,
          metadata,
          timestamp,
        });
      }
    }

    // Debug: log what we're inserting
    const metricTypesInserted = new Set(rowsToInsert.map(r => r.metricType));
    console.log(`Inserting ${rowsToInsert.length} metric rows with types:`, Array.from(metricTypesInserted));

    // Fire-and-forget: Don't await, just start the operation
    if (rowsToInsert.length > 0) {
      prisma.botsMetric
        .createMany({
          data: rowsToInsert,
        })
        .catch((err) => {
          // Log error but don't block response
          console.error('Error storing metrics:', err);
        });
    }

    // Return immediately (fire-and-forget)
    return NextResponse.json(
      { saved: rowsToInsert.length },
      { headers: corsHeaders() }
    );
  } catch (error: any) {
    if (error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    // For other errors, still return success (fire-and-forget)
    // Log the error but don't fail the request
    console.error('Error in metrics endpoint:', error);
    return NextResponse.json(
      { saved: 0 }, // Return success even on error (fire-and-forget)
      { headers: corsHeaders() }
    );
  }
}
