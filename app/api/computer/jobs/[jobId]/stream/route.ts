import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { reattachJobTurn } from '@/lib/computer-broker';
import { turnResponse } from '@/lib/computer-sse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/computer/jobs/:jobId/stream - the runner reconnects to the turn this job is running (after it, or Orbit, lost the stream): the
 * events so far, then the rest, same shape as the turn call. The turn is the job's own. 404 `no_turn` when none is running (or it ended
 * and is old): the runner then reads where the job stands and starts a new turn if it needs one. Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { jobId } = await params;
    const again = await reattachJobTurn(jobId, request.signal);
    if (again.ok) return turnResponse(again.events, request.signal);
    const status = again.reason === 'not_found' || again.reason === 'no_turn' ? 404 : again.reason === 'failed' ? 502 : 409;
    return NextResponse.json({ ok: false, reason: again.reason }, { status });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not reconnect to a turn:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
