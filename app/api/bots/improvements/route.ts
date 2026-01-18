import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/improvements
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * POST /api/bots/improvements
 * Store improvement cycles for tracking
 * 
 * Auth: BOT_SERVICE_TOKEN
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);

    const body = await request.json();

    const {
      botId,
      improvementType,
      changes,
      metricsBefore,
      metricsAfter,
      deployed = false,
    } = body;

    if (!changes) {
      return NextResponse.json(
        { error: 'changes is required' },
        { status: 400, headers: corsHeaders() }
      );
    }

    await prisma.botsImprovement.create({
      data: {
        botId: botId || null,
        improvementType: improvementType || null,
        changes,
        metricsBefore: metricsBefore || null,
        metricsAfter: metricsAfter || null,
        deployed,
      },
    });

    return NextResponse.json(
      { status: 'stored' },
      { headers: corsHeaders() }
    );
  } catch (error: any) {
    if (error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401, headers: corsHeaders() }
      );
    }

    console.error('Error storing improvement:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
