import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { WAITING_FOR, EFFECT_KINDS, FINISH_CAUSES } from '@/lib/computer-values';
import { claimJob, finishJobUnder, getJob, planEffect, recordFinishIntent, renewJob, reportProgressAs, requestHandoverAs, settleEffect } from '@/lib/computer';
import { SUPERSEDED } from '@/lib/computer-owner';
import { notesSent, pendingNotes } from '@/lib/computer-job-notes';

export const runtime = 'nodejs';
// Finishing a job hands its files over before it answers (limited by time: a few minutes), so a host that limits how long a request may run is told how long this one may
export const maxDuration = 300;

/** The run a runner is in, and the ownership epoch it won by claiming the job (every request after the claim names it; one that names none is a worker that knows none: good only while the job has none). */
const runSchema = z.string().min(1).max(40).regex(/^[0-9A-Za-z._:-]+$/);
const epochSchema = z.number().int().min(0).max(2_000_000_000).nullable().optional();

const actionSchema = z.discriminatedUnion('action', [
  // The runner takes up a job: it names the owner epoch it last saw (`GET`'s `ownerEpoch`) and wins only if that is still the job's
  z.object({ action: z.literal('claim'), run: runSchema.nullable().optional(), seen: z.number().int().min(0).max(2_000_000_000) }),
  z.object({ action: z.literal('progress'), epoch: epochSchema, stepDone: z.number().int().min(0), stepTotal: z.number().int().min(1).nullable().optional(), label: z.string().max(200).nullable().optional() }),
  z.object({ action: z.literal('renew'), epoch: epochSchema, /** The run the runner is in (the one it prepares with): a renewal from a run that was replaced answers `stale` and holds nothing. Left out, as before. */ run: z.string().min(1).max(40).regex(/^[0-9A-Za-z._:-]+$/).nullable().optional() }),
  z.object({
    action: z.literal('handover'),
    epoch: epochSchema,
    /** The control generation the worker acts under, and the turn it was on: the wait lands only while they are the job's. */
    generation: z.number().int().min(0).nullable().optional(),
    responseId: z.string().min(1).max(200).nullable().optional(),
    waitingFor: z.enum(WAITING_FOR),
    /** For "details": what Brick is ready to put in and where, named before the person is asked. */
    ready: z.object({ what: z.string().trim().min(1).max(150), where: z.string().trim().min(1).max(150) }).nullable().optional(),
  }),
  z.object({ action: z.literal('finish'), epoch: epochSchema, outcome: z.enum(['done', 'failed']), /** Who a failure is down to (`ours` is given back, `agent` is the person's); left out, it is the person's. */ cause: z.enum(FINISH_CAUSES).nullable().optional(), /** The turns the runner judged failed: Orbit decides a give-back from the relay's rows for them (the cause is only a hint). */ turns: z.array(z.number().int().min(0).max(100_000)).max(200).nullable().optional(), /** The runner's run (a restart makes a new run that numbers turns again): where the failure's turns were numbered, and which run is finishing. A finish from a run that was replaced (another run prepared since) answers `stale` and ends nothing. Send it with EVERY finish. */ run: z.string().min(1).max(40).regex(/^[0-9A-Za-z._:-]+$/).nullable().optional(), /** The computer's one sentence about why it could not go on; cleaned before it is kept. */ why: z.string().max(2000).nullable().optional(), /** The control generation the runner acts under (from `GET`): a finish from an older one is `stale` and does nothing. Left out, as before. */ generation: z.number().int().min(0).nullable().optional() }),
  // The runner's committed word that this job is to end, kept BEFORE it gives up (what the finish will say, as the finish says it)
  z.object({ action: z.literal('finish-intent'), epoch: epochSchema, outcome: z.enum(['done', 'failed']), cause: z.enum(FINISH_CAUSES).nullable().optional(), turns: z.array(z.number().int().min(0).max(100_000)).max(200).nullable().optional(), run: z.string().min(1).max(40).regex(/^[0-9A-Za-z._:-]+$/).nullable().optional(), why: z.string().max(2000).nullable().optional(), generation: z.number().int().min(0).nullable().optional(), /** What the stop rests on: `pool` = the runner gives up only because the pool refused its calls. A stop on that basis is stale once a call was admitted for its turn (or a later one) of the run. */ basis: z.enum(['pool']).nullable().optional() }),
  z.object({ action: z.literal('plan-effect'), key: z.string().min(1).max(255), kind: z.enum(EFFECT_KINDS), evidence: z.string().max(500).nullable().optional() }),
  // The runner gave the agent every pending note up to `through` (the highest `seq` it sent): marked sent once, by the job's owner only
  z.object({ action: z.literal('notes-sent'), epoch: epochSchema, through: z.number().int().min(1).max(2_000_000_000) }),
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
 * to be done (what and where), and `notes`: what the person told the job since it started that the agent has not been given yet ([{ seq, text }], in
 * order). Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  const denied = guard(request);
  if (denied) return denied;
  const { id, jobId } = await params;
  const job = await jobOf(id, jobId);
  // `job.notes`: what the person told the job since it started, still to give the agent, in order ([{ seq, text }]); after giving them, say `notes-sent` with the highest seq
  return job ? NextResponse.json({ job: { ...job, notes: await pendingNotes(jobId) } }) : NextResponse.json({ error: 'Job not found' }, { status: 404 });
}

/**
 * POST /api/bots/:id/computer-jobs/:jobId { action, ... } (game #2000). What a running job tells us, each safe to say twice:
 * `progress` (step n of m), `renew` (keep its room; with `run`, a renewal from a run that was replaced answers `{ ok: false, reason: 'stale', run: 'superseded' }` and holds nothing: answers `{ ok: false, reason }` when the allowance or our room is used up, and the
 * job has then saved and stopped), `handover` (it needs its person before details, a sign-in, an upload, paying or submitting),
 * `finish` (idempotent: a job that is over answers as it ended, nothing is written twice; with `generation`, an older control generation answers HTTP 200 `{ ok: false, reason: 'stale', job }` and does nothing; so does a `run` that is not the job's current one, i.e. a run that was replaced by a prepare of another (the answer then also says `run: 'superseded'`, which a stale generation never does): send `run` with every finish), `finish-intent` (the runner's committed word that the job is to end, kept BEFORE it gives up: first wins; every key of the job ends in the same transaction and no key, prepare, call or turn is allowed for it from then on; the job then shows `finishPending` on GET until a finish ends it, and the sweep completes it after about 2 minutes with what was said; answers HTTP 200 `{ ok: true, already, finishPending }` or `{ ok: false, reason: 'stale' | 'cutoff', job }`: stale = the job is over, was never started, or is on another generation; cutoff = Orbit already decided to end it for its own capacity, which wins; with `basis: 'pool'` (the runner gives up only because the pool refused its calls) a call admitted for the turn it names (the earliest of `turns`), or a later one, of the same run makes it stale too: capacity came back and the work goes on, nothing is written; an admission on an earlier turn never does), `notes-sent` (the runner gave the agent the person's notes up to `through`, the highest `seq` it sent: marked once, only by the job's owner), and `plan-effect` / `settle-effect` for anything it does outside its computer. `plan-effect` is written BEFORE it is
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
      case 'claim': {
        // Every answer is HTTP 200: `{ ok: true, epoch, job }` (the job is this runner's now: name `epoch` on every request), `{ ok: false, reason: 'stale', run: 'superseded', ownerEpoch, job }` (someone claimed since `seen`: read `ownerEpoch` and claim again),
        // `{ ok: false, reason: 'finish_pending', finishPending, job }` (complete the kept intent, no ownership is taken), `cutoff`, `over`, `not_running`
        const claimed = await claimJob(jobId, { run: body.run ?? null, seen: body.seen });
        const job = await getJob(jobId);
        if (claimed.ok) return NextResponse.json({ ok: true, epoch: claimed.epoch, job });
        if (claimed.reason === 'superseded') return NextResponse.json({ ...SUPERSEDED, ownerEpoch: claimed.ownerEpoch, job });
        if (claimed.reason === 'not_found') return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        return NextResponse.json({ ok: false, reason: claimed.reason, ...(claimed.reason === 'finish_pending' ? { finishPending: job?.finishPending ?? null } : {}), job });
      }
      case 'progress': {
        const done = await reportProgressAs(jobId, { stepDone: body.stepDone, stepTotal: body.stepTotal, label: body.label }, { epoch: body.epoch });
        return NextResponse.json(done.superseded ? { ...SUPERSEDED, job: done.job } : { job: done.job });
      }
      case 'renew':
        // `{ ok: true, renewInSeconds }`, or `{ ok: false, reason }`: allowance, pool, closed, over, unanswered, rule (the job has saved and stopped), `ending` (a finish intent is kept or a pool cutoff is decided: no room was added, the finalizer ends the job: abort the turn, read the job, complete the finish), or `stale` with `run: 'superseded'` (not the owner: exit)
        return NextResponse.json(await renewJob(jobId, new Date(), { epoch: body.epoch }));
      case 'handover': {
        const done = await requestHandoverAs(jobId, body.waitingFor, new Date(), body.ready, { epoch: body.epoch, generation: body.generation, responseId: body.responseId });
        if (done.refused === 'superseded') return NextResponse.json({ ...SUPERSEDED, job: done.job });
        if (done.refused) return NextResponse.json({ ok: false, reason: done.refused, job: done.job });
        return NextResponse.json({ job: done.job });
      }
      case 'finish': {
        const finished = await finishJobUnder(jobId, body.generation, body.outcome, new Date(), body.why, body.cause, body.turns, body.run, body.epoch);
        // A finish from an older control generation is business, not an error: HTTP 200 `{ ok: false, reason: 'stale', job }` and nothing changed
        return NextResponse.json(finished.stale ? { ok: false, reason: 'stale', ...(finished.superseded ? { run: 'superseded' } : {}), job: finished.job } : { job: finished.job });
      }
      case 'finish-intent': {
        const kept = await recordFinishIntent(jobId, { outcome: body.outcome, cause: body.cause, why: body.why, turns: body.turns, run: body.run, generation: body.generation, basis: body.basis, epoch: body.epoch });
        // Every answer is HTTP 200: `{ ok: true, finishPending, already }` (kept; `already` when an earlier intent was kept first), or `{ ok: false, reason: 'stale' | 'cutoff', job }`
        if (kept.ok) return NextResponse.json({ ok: true, already: kept.already, finishPending: kept.pending });
        // A job that was taken away after the Brick check above is not found, as everywhere else on this route (HTTP 404); `stale` and `cutoff` stay HTTP 200
        if (kept.reason === 'not_found') return NextResponse.json({ error: 'Job not found' }, { status: 404 });
        return NextResponse.json({ ok: false, reason: kept.reason, ...(kept.run ? { run: kept.run } : {}), job: await getJob(jobId) });
      }
      case 'plan-effect':
        return NextResponse.json(await planEffect(jobId, { key: body.key, kind: body.kind, evidence: body.evidence }));
      case 'notes-sent': {
        // `{ ok: true, sent }` (sent = how many were marked now; 0 when said again), `{ ok: false, reason: 'stale', run: 'superseded' }` (not the owner: exit), `{ ok: false, reason: 'over' }`
        return NextResponse.json(await notesSent(jobId, { through: body.through, epoch: body.epoch }));
      }
      case 'settle-effect':
        return NextResponse.json({ ok: await settleEffect(jobId, body.key, body.state, body.evidence) });
    }
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] A job call failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
