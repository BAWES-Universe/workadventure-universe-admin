import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { WAITING_FOR, EFFECT_KINDS } from '@/lib/computer-values';
import { finishJob, getJob, planEffect, renewJob, reportProgress, requestHandover, settleEffect } from '@/lib/computer';

export const runtime = 'nodejs';

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('progress'), stepDone: z.number().int().min(0), stepTotal: z.number().int().min(1).nullable().optional(), label: z.string().max(200).nullable().optional() }),
  z.object({ action: z.literal('renew') }),
  z.object({
    action: z.literal('handover'),
    waitingFor: z.enum(WAITING_FOR),
    /** For "details": what Brick is ready to put in and where, named before the person is asked. */
    ready: z.object({ what: z.string().trim().min(1).max(150), where: z.string().trim().min(1).max(150) }).nullable().optional(),
  }),
  z.object({ action: z.literal('finish'), outcome: z.enum(['done', 'failed']) }),
  z.object({ action: z.literal('plan-effect'), key: z.string().min(1).max(255), kind: z.enum(EFFECT_KINDS), evidence: z.string().max(500).nullable().optional() }),
  z.object({ action: z.literal('settle-effect'), key: z.string().min(1).max(255), state: z.enum(['done', 'failed']), evidence: z.string().max(500).nullable().optional() }),
]);

function guard(request: NextRequest): NextResponse | null {
  try {
    requireServiceToken(request);
    return null;
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
}

/** The job, only through the Brick it belongs to: a job id is never enough on its own. */
async function jobOf(botId: string, jobId: string) {
  const job = await getJob(jobId);
  return job && job.botId === botId ? job : null;
}

/**
 * GET /api/bots/:id/computer-jobs/:jobId - the job as it stands, with the details the person asked Brick to fill in that are still
 * to be done (what and where). Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const denied = guard(request);
  if (denied) return denied;
  const { id, jobId } = await params;
  const job = await jobOf(id, jobId);
  return job ? NextResponse.json({ job }) : NextResponse.json({ error: 'Job not found' }, { status: 404 });
}

/**
 * POST /api/bots/:id/computer-jobs/:jobId { action, ... } (game #2000). What a running job tells us, each safe to say twice:
 * `progress` (step n of m), `renew` (keep its room: answers `{ ok: false, reason }` when the allowance or our room is used up, and the
 * job has then saved and stopped), `handover` (it needs its person before details, a sign-in, an upload, paying or submitting),
 * `finish`, and `plan-effect` / `settle-effect` for anything it does outside its computer. `plan-effect` is written BEFORE it is
 * tried: `look_up` means it was tried before and the outcome is not known, so Brick looks it up and settles it, never repeats it.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const denied = guard(request);
  if (denied) return denied;
  try {
    const { id, jobId } = await params;
    if (!(await jobOf(id, jobId))) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    const parsed = actionSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const body = parsed.data;
    switch (body.action) {
      case 'progress':
        return NextResponse.json({ job: await reportProgress(jobId, { stepDone: body.stepDone, stepTotal: body.stepTotal, label: body.label }) });
      case 'renew':
        return NextResponse.json(await renewJob(jobId));
      case 'handover':
        return NextResponse.json({ job: await requestHandover(jobId, body.waitingFor, new Date(), body.ready) });
      case 'finish':
        return NextResponse.json({ job: await finishJob(jobId, body.outcome) });
      case 'plan-effect':
        return NextResponse.json(await planEffect(jobId, { key: body.key, kind: body.kind, evidence: body.evidence }));
      case 'settle-effect':
        return NextResponse.json({ ok: await settleEffect(jobId, body.key, body.state, body.evidence) });
    }
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] A job call failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
