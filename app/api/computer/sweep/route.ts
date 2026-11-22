import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { sweepComputers } from '@/lib/computer';

export const runtime = 'nodejs';

/**
 * POST /api/computer/sweep
 * Asked by the bot server now and then (game #2000): a job that stopped renewing its room is stopped safely, room nobody holds a job
 * for is given back, and jobs waiting in line are tried again. Safe to run twice at once. Answers { stopped, released, started }.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    return NextResponse.json(await sweepComputers());
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Sweep failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
