import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { FAULT_KINDS, FAULT_SOURCES, isArrivalRow, recordFaults } from '@/lib/computer-faults';
import { afterArrival, afterLateEvidence } from '@/lib/computer-giveback';

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
})
  // The only answered row the relay ever sends is its arrival row (answered / relay_reached, from the relay, no route, no status). Any other answered row is refused: it would count as a trace of a call
  // and could stop an outage from being given back
  .refine((row) => row.kind !== 'answered' || (isArrivalRow(row) && !row.route && row.providerStatus == null), { message: 'answered rows are the relay’s arrival row only' });
// The batch itself is bounded; each row is read on its own, so one row that is not shaped as the relay writes it never holds back the real fault rows sent with it
const bodySchema = z.object({ faults: z.array(z.unknown()).min(1).max(50) });

/**
 * POST /api/bots/:id/computer-jobs/:jobId/faults { faults: [{ turn, callId, kind, reason, source, route, providerStatus, at }, ...] }: what the game relay saw go
 * wrong (or be uncertain) on a job's model calls, kept once per (job, call) so Orbit, and not a process's memory, judges whether a failed job is given back.
 * Written BEFORE the job finishes; a row that arrives after it is still kept and can still make the job a give-back (a fault of ours it names). Safe to say twice.
 * Answers { ok, stored, conflicts, rejected? } (`rejected`: how many rows of the batch were not shaped as the relay writes them and were left out, only when some were: the rest are kept; a batch with nothing that can be kept is a 400. `conflicts`: rows whose call id another run or turn of the job already holds: said, never dropped silently). Auth: service token only (the bot server's, like every route the computer's runner calls).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id, jobId } = await params;
  let rows: Array<z.infer<typeof faultSchema>>;
  let rejected: number;
  try {
    const body = bodySchema.parse(await request.json());
    const read = body.faults.map((row) => faultSchema.safeParse(row));
    rows = read.flatMap((one) => (one.success ? [one.data] : []));
    rejected = read.length - rows.length;
    // A batch with nothing that can be kept is refused as it always was; one with some rows that can is kept, and says how many it could not read
    if (rows.length === 0) throw new Error('no row can be read');
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  try {
    const kept = await recordFaults(id, jobId, rows.map((row) => ({ ...row, turn: row.turn ?? null, run: row.run ?? null, route: row.route ?? null, providerStatus: row.providerStatus ?? null })));
    if (!kept) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    // A row for a job that is already over can change what was decided about it. A batch of nothing but arrival rows (the relay says a run reached it) judges nothing: it only re-labels a reason
    const judge = rows.every((row) => isArrivalRow(row)) ? afterArrival(jobId) : afterLateEvidence(jobId);
    await judge.catch((error) => console.error('[Computer] Late evidence could not be judged:', error instanceof Error ? error.message : 'unknown'));
    return NextResponse.json({ ok: true, stored: kept.stored, conflicts: kept.conflicts, ...(rejected > 0 ? { rejected } : {}) });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer', step: 'faults' } });
    return NextResponse.json({ error: 'Could not keep the faults' }, { status: 500 });
  }
}
