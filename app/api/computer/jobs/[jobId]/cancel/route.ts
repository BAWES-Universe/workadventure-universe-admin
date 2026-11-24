import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { requireServiceToken } from '@/lib/service-tokens';
import { z } from 'zod';
import { cancelJobTurn } from '@/lib/computer-broker';
import { refusalBody } from '@/lib/computer-owner';

export const runtime = 'nodejs';

// The turn the runner means (`responseId`) and the ownership epoch it won by claiming the job: only the owner cancels, and only that turn
const bodySchema = z.object({ epoch: z.number().int().min(0).max(2_000_000_000).nullable().optional(), responseId: z.string().min(1).max(200).nullable().optional() }).strict();

/**
 * POST /api/computer/jobs/:jobId/cancel { epoch, responseId } - cancels the turn the runner NAMES, if it is still the job's own turn and the runner owns the job. It still ends with a completed event holding what it wrote before.
 * Answers { ok: true, cancelled } or { ok: true, cancelled: false, reason: 'not_current' } (the turn named is not the job's now: nothing was cancelled); 409 `{ ok: false, reason: 'stale', run: 'superseded' }` when the runner does not own the job.
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
    const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const done = await cancelJobTurn(jobId, { epoch: parsed.data.epoch ?? null, responseId: parsed.data.responseId ?? null });
    if (done.ok) return NextResponse.json({ ok: true, cancelled: done.cancelled, ...(done.reason ? { reason: done.reason } : {}) });
    return NextResponse.json(refusalBody(done.reason), { status: done.reason === 'not_found' ? 404 : done.reason === 'failed' ? 502 : 409 });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not cancel a turn:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
