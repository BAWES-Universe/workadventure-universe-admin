import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { sweepComputers } from '@/lib/computer';
import { forgetEndedJobNotes } from '@/lib/computer-job-notes';

export const runtime = 'nodejs';

/**
 * POST /api/computer/sweep
 * Asked by the bot server now and then (game #2000): a job that stopped renewing its room is stopped safely, room nobody holds a job
 * for is given back, and jobs waiting in line are tried again, and the notes of jobs that are over are forgotten. Safe to run twice at once. Answers { stopped, released, started, notesForgotten }.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    const swept = await sweepComputers();
    // What the person told a job is for that job's agent only: forgotten once the job is over
    const notesForgotten = await forgetEndedJobNotes().catch((error) => {
      Sentry.captureException(error, { tags: { area: 'computer' } });
      return 0;
    });
    return NextResponse.json({ ...swept, notesForgotten });
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Sweep failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
