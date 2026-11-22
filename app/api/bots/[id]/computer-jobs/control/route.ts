import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { brickOf, computerView, stopJobFor } from '@/lib/computer';
import { cancelJob, moveJobFirst, pauseJob, resumeJob } from '@/lib/computer-job-controls';
import { addJobNote, NOTE_MAX } from '@/lib/computer-job-notes';
import { jobActivity } from '@/lib/computer-job-steps';

export const runtime = 'nodejs';

const jobIdSchema = z.string().min(1).max(64);

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('stop'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('activity'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional(), jobId: jobIdSchema }).strict(),
  z.object({ action: z.literal('pause'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional(), jobId: jobIdSchema }).strict(),
  z.object({ action: z.literal('resume'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional(), jobId: jobIdSchema }).strict(),
  z.object({ action: z.literal('cancel'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional(), jobId: jobIdSchema }).strict(),
  z.object({ action: z.literal('first'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional(), jobId: jobIdSchema, pauseRunning: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('note'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional(), jobId: jobIdSchema, text: z.string().trim().min(1).max(NOTE_MAX) }).strict(),
]);

/**
 * POST /api/bots/:id/computer-jobs/control { personId, isGuest?, action, jobId?, text?, pauseRunning? }
 * Brick's door to its own computer jobs (computers full plan, piece 2): the bot server's Brick tools call it from the person's own words in their chat
 * with the Brick ("pause the visa", "do the clock first", "cancel the hotel one", "use 12 March instead", "how is it going?"). The same library calls and
 * the same owner check as the person's own buttons: only the Brick's owner, only jobs of this Brick. `personId` is the person as the game knows them
 * (the same value as `userId` on a start), resolved the same way.
 *
 * Actions:
 *  - `list`: `{ ok: true, view }`, the computer as the page shows it (the job that has the machine, the line with paused jobs, the month).
 *  - `activity` (jobId): `{ ok: true, job: { id, title, status }, steps: [{ seq, label, at }] }`, oldest first.
 *  - `pause`, `resume`, `cancel` (jobId), `first` (jobId, `pauseRunning`): `{ ok: true, view }`.
 *  - `note` (jobId, text): `{ ok: true, view, note: { seq, delivery } }`, delivery: now, answer, after_hand_back, when_it_starts.
 *  - `stop`: ends everything on the computer, paused jobs included: `{ ok: true, view }`.
 *
 * Every refusal is HTTP 200 `{ ok: false, reason }`: `not_owner` (a guest, or not this Brick's owner), `not_found` (no such job on this Brick), and the
 * controls' own words: `over`, `taken_over`, `ending`, `not_paused`, `not_queued`. Anything else is "could not do it", never done. 503 `{ retry: true }`
 * when who it was for could not be looked up just now (ask again). Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const parsed = bodySchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    const body = parsed.data;
    const person = await resolveUsagePerson(body.personId, body.isGuest);
    if (person.lookupFailed) return NextResponse.json({ error: 'Could not tell who this was for, ask again', retry: true }, { status: 503 });
    // Only the Brick's owner, the same check as a start: a guest, someone else, or a bot in a room has nothing here
    const ownerId = person.personId;
    if (!ownerId || !(await brickOf(id, ownerId))) return NextResponse.json({ ok: false, reason: 'not_owner' });
    switch (body.action) {
      case 'list':
      case 'stop': {
        const view = body.action === 'stop' ? await stopJobFor(id, ownerId) : await computerView(id, ownerId);
        return NextResponse.json(view ? { ok: true, view } : { ok: false, reason: 'not_owner' });
      }
      case 'activity': {
        const activity = await jobActivity(id, ownerId, body.jobId);
        return NextResponse.json(activity.ok ? { ok: true, job: activity.job, steps: activity.steps } : { ok: false, reason: activity.reason });
      }
      case 'note': {
        const noted = await addJobNote(id, ownerId, body.jobId, body.text);
        return NextResponse.json(noted.ok ? { ok: true, view: noted.view, note: noted.note } : { ok: false, reason: noted.reason });
      }
      case 'pause':
        return NextResponse.json(await pauseJob(id, ownerId, body.jobId));
      case 'resume':
        return NextResponse.json(await resumeJob(id, ownerId, body.jobId));
      case 'cancel':
        return NextResponse.json(await cancelJob(id, ownerId, body.jobId));
      case 'first':
        return NextResponse.json(await moveJobFirst(id, ownerId, body.jobId, { pauseRunning: body.pauseRunning === true }));
    }
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] A control of a computer job failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
