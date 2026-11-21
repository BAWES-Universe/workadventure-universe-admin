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
 * Answers { ok, stored, conflicts, rejected?, rejectedCount? } (`rejected`: [{ callId, why }] for each row of the batch that was not shaped as the relay writes it and was left out (the call id when it has a readable one, and the names of the wrong fields), only when some were: the rest are kept, and Sentry is warned once; a batch with nothing that can be kept is a 400 that names its rows too. `conflicts`: rows whose call id another run or turn of the job already holds: said, never dropped silently). Auth: service token only (the bot server's, like every route the computer's runner calls).
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; jobId: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id, jobId } = await params;
  let rows: Array<z.infer<typeof faultSchema>>;
  // The rows that could not be read, named so the sender can keep exactly those (never a silent loss): the call id when the row has a readable one, and the names of the fields that were wrong (never their content)
  let rejected: Array<{ callId: string | null; why: string }> = [];
  try {
    const body = bodySchema.parse(await request.json());
    const read = body.faults.map((row) => ({ row, parsed: faultSchema.safeParse(row) }));
    rows = read.flatMap((one) => (one.parsed.success ? [one.parsed.data] : []));
    rejected = read.flatMap((one) => {
      if (one.parsed.success) return [];
      const callId = typeof (one.row as { callId?: unknown } | null)?.callId === 'string' && ((one.row as { callId: string }).callId.length >= 1 && (one.row as { callId: string }).callId.length <= 120) ? (one.row as { callId: string }).callId : null;
      return [{ callId, why: [...new Set(one.parsed.error.issues.map((issue) => issue.path.join('.') || (issue.code === 'custom' ? 'answered' : 'row')))].join(',').slice(0, 120) }];
    });
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  // ONE warning per batch with a row that could not be read: field names only, never a row's content. A row the sender thought was evidence is then neither lost nor silent
  if (rejected.length > 0) {
    try {
      Sentry.captureMessage('The computer faults route could not read some rows of a batch', { level: 'warning', tags: { area: 'computer', step: 'faults_rejected' }, extra: { jobId, count: rejected.length, paths: [...new Set(rejected.flatMap((one) => one.why.split(',')))] } });
    } catch {
      // Telling Sentry never changes the answer
    }
  }
  // A batch with nothing that can be kept is refused as it always was (and names its rows); one with some rows that can is kept, and names the ones it could not read
  if (rows.length === 0) return NextResponse.json({ error: 'Invalid request', rejected, rejectedCount: rejected.length }, { status: 400 });
  try {
    const kept = await recordFaults(id, jobId, rows.map((row) => ({ ...row, turn: row.turn ?? null, run: row.run ?? null, route: row.route ?? null, providerStatus: row.providerStatus ?? null })));
    if (!kept) return NextResponse.json({ error: 'Job not found' }, { status: 404 });
    // A row for a job that is already over can change what was decided about it. A batch of nothing but arrival rows (the relay says a run reached it) judges nothing: it only re-labels a reason
    const judge = rows.every((row) => isArrivalRow(row)) ? afterArrival(jobId) : afterLateEvidence(jobId);
    await judge.catch((error) => console.error('[Computer] Late evidence could not be judged:', error instanceof Error ? error.message : 'unknown'));
    return NextResponse.json({ ok: true, stored: kept.stored, conflicts: kept.conflicts, ...(rejected.length > 0 ? { rejected, rejectedCount: rejected.length } : {}) });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer', step: 'faults' } });
    return NextResponse.json({ error: 'Could not keep the faults' }, { status: 500 });
  }
}
