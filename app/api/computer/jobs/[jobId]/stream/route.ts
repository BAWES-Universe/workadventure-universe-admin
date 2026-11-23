import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { reattachJobTurn } from '@/lib/computer-broker';
import { turnResponse } from '@/lib/computer-sse';
import { refusalBody } from '@/lib/computer-owner';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The ownership epoch the runner won by claiming the job (`?epoch=`): a worker that names none is served only while the job has none. An epoch that is named but is not a whole number in range is `invalid`, never
 * the same as none: a reconnect with `?epoch=abc` must not be served as a legacy reconnect (CodeRabbit on #1025). Omitted and `epoch=0` stay as they were.
 */
function epochOf(request: NextRequest): { epoch: number | null } | 'invalid' {
  const raw = request.nextUrl.searchParams.get('epoch');
  if (raw === null) return { epoch: null };
  if (!/^[0-9]{1,10}$/.test(raw)) return 'invalid';
  const epoch = Number(raw);
  return Number.isSafeInteger(epoch) && epoch <= 2_000_000_000 ? { epoch } : 'invalid';
}

/**
 * GET /api/computer/jobs/:jobId/stream?epoch=N - the runner reconnects to the turn this job is running (after it, or Orbit, lost the stream): the
 * events so far, then the rest, same shape as the turn call. The turn is the job's own. 400 for an epoch that is named but invalid. 404 `no_turn` when none is running (or it ended
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
    const named = epochOf(request);
    if (named === 'invalid') return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const again = await reattachJobTurn(jobId, request.signal, { epoch: named.epoch });
    if (again.ok) return turnResponse(again.events, request.signal);
    const status = again.reason === 'not_found' || again.reason === 'no_turn' ? 404 : again.reason === 'failed' ? 502 : 409;
    return NextResponse.json(refusalBody(again.reason), { status });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not reconnect to a turn:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
