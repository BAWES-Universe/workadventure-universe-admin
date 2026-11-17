import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { cancelJobTurn } from '@/lib/computer-broker';

export const runtime = 'nodejs';

/**
 * POST /api/computer/jobs/:jobId/cancel - cancels the turn the agent is running for this job, if it is running one. The turn is the
 * job's own: the caller names none. It still ends with a completed event holding what it wrote before. Answers { ok: true, cancelled }.
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { jobId } = await params;
    const done = await cancelJobTurn(jobId);
    if (done.ok) return NextResponse.json({ ok: true, cancelled: done.cancelled });
    return NextResponse.json({ ok: false, reason: done.reason }, { status: done.reason === 'not_found' ? 404 : done.reason === 'failed' ? 502 : 409 });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not cancel a turn:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
