import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { prepareJob } from '@/lib/computer-broker';
import { afterLateEvidence } from '@/lib/computer-giveback';
import { refusalBody } from '@/lib/computer-owner';

export const runtime = 'nodejs';

const bodySchema = z
  .object({
    relay: z.string().min(1).max(300),
    // What the bot server's own look at the relay saw: false only when the reply was not the relay's; the HTTP status it saw (null: no reply). Left out by a sender that does not look
    relayReached: z.boolean().optional(),
    relayStatus: z.number().int().min(0).max(599).nullable().optional(),
    // The runner's run the job is on (a fault kept for it names it); left out by a sender that names none
    run: z.string().min(1).max(40).regex(/^[0-9A-Za-z._:-]+$/).nullable().optional(),
    /** The ownership epoch the runner won by claiming the job (a worker that names none is served only while the job has none). */
    epoch: z.number().int().min(0).max(2_000_000_000).nullable().optional(),
  })
  .strict();

/**
 * POST /api/computer/jobs/:jobId/prepare { relay, epoch, run?, relayReached?, relayStatus? } - the runner readies a running job's computer to ask for a model: Orbit makes a new
 * key (every earlier key of the job ends) and writes it, with the relay's address, onto the machine where its local model address reads
 * them on each call. The key never comes back to the caller. Answers { ok: true, expiresAt, git } (git: whether the computer was given its git login) or { ok: false, reason }. 
 * After writing the key the computer asks the relay for its model list with it; if it cannot, Orbit keeps one confirmed fault of ours for the job (reason `relay_unreachable`, always given back, never counted) and answers 409 `{ ok: false, reason: 'relay_unreachable' }`.
 * 409 `{ ok: false, reason: 'stale', run: 'superseded' }` when the runner does not own the job (`epoch` is not the job's: another claimed it since, or this runner never did): nothing was made, and the owner's keys stand.
 * 409 `preparing` when another prepare of the job is writing its key (waited for about 5 seconds first: ask again, it is not a failure; the claim lapses after about 45 seconds). Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const { jobId } = await params;
    const done = await prepareJob(jobId, parsed.data.relay, new Date(), { run: parsed.data.run ?? null, epoch: parsed.data.epoch ?? null, relayReached: parsed.data.relayReached, relayStatus: parsed.data.relayStatus ?? null });
    // A job that is already over may have been decided before this was said: the late row can make it a give-back
    if (!done.ok && done.reason === 'relay_unreachable') await afterLateEvidence(jobId).catch((error) => console.error('[Computer] Late evidence could not be judged:', error instanceof Error ? error.message : 'unknown'));
    if (done.ok) return NextResponse.json({ ok: true, expiresAt: done.expiresAt.toISOString(), git: done.git }, { headers: { 'Cache-Control': 'no-store' } });
    const status = done.reason === 'not_found' ? 404 : done.reason === 'bad_relay' ? 400 : done.reason === 'failed' ? 502 : 409;
    return NextResponse.json(refusalBody(done.reason), { status });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not prepare a job:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
