import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { sweepCodeJobs } from '@/lib/workbench/executor';

export const runtime = 'nodejs';

/**
 * POST /api/workbench/sweep
 * Orbit runs this on its own timer; this is for anything that wants it run now. Jobs past their deadline, or whose process stopped, are ended and
 * their workspaces deleted; workspaces that could not be deleted are deleted again; results and files past "days kept" are removed. Safe to run
 * twice at once. Auth: service token only.
 */
export async function POST(request: NextRequest) {
  try {
    requireServiceToken(request);
    return NextResponse.json(await sweepCodeJobs());
  } catch (error) {
    if (error instanceof Error && error.message === 'Unauthorized: Invalid service token') return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    Sentry.captureException(error, { tags: { area: 'code-jobs' } });
    console.error('[CodeJob] Sweep failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
