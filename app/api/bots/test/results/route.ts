import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { requireServiceToken } from '@/lib/service-tokens';
import { corsHeaders } from '@/lib/cors';

export const runtime = 'nodejs';

/**
 * OPTIONS /api/bots/test/results
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return NextResponse.json({}, { headers: corsHeaders() });
}

/**
 * POST /api/bots/test/results
 * Store test results for regression testing
 * 
 * Auth: BOT_SERVICE_TOKEN
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);

    const body = await request.json();

    const {
      testId,
      botId,
      testSuite,
      results,
      passed,
    } = body;

    if (!testId || !results || passed === undefined) {
      return NextResponse.json(
        { error: 'testId, results, and passed are required' },
        { status: 400, headers: corsHeaders() }
      );
    }

    // Upsert test result (update if exists)
    await prisma.botsTestResult.upsert({
      where: { testId },
      update: {
        botId: botId || null,
        testSuite: testSuite || null,
        results,
        passed,
      },
      create: {
        testId,
        botId: botId || null,
        testSuite: testSuite || null,
        results,
        passed,
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

    console.error('Error storing test result:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500, headers: corsHeaders() }
    );
  }
}
