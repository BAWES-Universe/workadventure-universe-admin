import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { FAULT_KINDS, FAULT_SOURCES, recordFaults } from '@/lib/computer-faults';
import { afterLateEvidence } from '@/lib/computer-giveback';

export const runtime = 'nodejs';

const faultSchema = z.object({
  turn: z.number().int().min(0).max(100_000).nullable().optional(),
  // The runner's run the turn was numbered in (a restart makes a new run, numbering turns from 1 again); left out by a runner that names none
  run: z.string().min(1).max(40).regex(/^[0-9A-Za-z._:-]+$/).nullable().optional(),
  // One row per model call; a fault with no call is `turn:<n>`
  callId: z.string().min(1).max(120),
  kind: z.enum(FAULT_KINDS),
  reason: z.string().min(1).max(32).regex(/^[a-z0-9_]+$/),
  source: z.enum(FAULT_SOURCES),
  route: z.string().min(1).max(120).nullable().optional(),
  providerStatus: z.number().int().min(100).max(599).nullable().optional(),
  at: z.coerce.date(),
});
const bodySchema = z.object({ faults: z.array(faultSchema).min(1).max(50) });

/**
 * POST /api/bots/:id/computer-jobs/:jobId/faults { faults: [{ turn, callId, kind, reason, source, route, providerStatus, at }, ...] }: what the game relay saw go
 * wrong (or be uncertain) on a job's model calls, kept once per (job, call) so Orbit, and not a process's memory, judges whether a failed job is given back.
 * Written BEFORE the job finishes; a row that arrives after it is still kept and can still make the job a give-back (a fault of ours it names). Safe to say twice.
 * Answers { ok, stored, conflicts } (`conflicts`: rows whose call id another run or turn of the job already holds: said, never dropped silently). Auth: service token only (the bot server's, like every route the computer's runner calls).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id, jobId } = await params;
  let body: z.infer<typeof bodySchema>;
  try {
    body = bodySchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  try {
    const kept = await recordFaults(id, jobId, body.faults.map((row) => ({ ...row, turn: row.turn ?? null, run: row.run ?? null, route: row.route ?? null, providerStatus: row.providerStatus ?? null })));
    if (!kept) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    // A row for a job that is already over can change what was decided about it
    await afterLateEvidence(jobId).catch((error) => console.error('[Computer] Late evidence could not be judged:', error instanceof Error ? error.message : 'unknown'));
    return NextResponse.json({ ok: true, stored: kept.stored, conflicts: kept.conflicts });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer', step: 'faults' } });
    return NextResponse.json({ error: 'Could not keep the faults' }, { status: 500 });
  }
}
