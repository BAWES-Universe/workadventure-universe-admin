import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { sweepComputers } from '@/lib/computer';
import { sweepPausedSignIns } from '@/lib/computer-browser-profile';

export const runtime = 'nodejs';

/**
 * POST /api/computer/sweep
 * Asked by the bot server now and then (game #2000): a job that stopped renewing its room is stopped safely, room nobody holds a job
 * for is given back, jobs waiting in line are tried again, and paused jobs' browser sign-ins kept too long are removed. Safe to run twice at once. Answers { stopped, released, started }.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const swept = await sweepComputers();
    // Paused jobs' kept browser sign-ins past the time they are kept are removed from awake machines (never throws, never wakes a machine)
    await sweepPausedSignIns();
    return NextResponse.json(swept);
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Sweep failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
