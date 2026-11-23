import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { brickOf, computerView, stopAll, STOP_CONFIRMED_MAX } from '@/lib/computer';
import { commandOf, COMMAND_HEADER } from '@/lib/computer-commands';
import { cancelJob, moveJobFirst, pauseJob, resumeJob } from '@/lib/computer-job-controls';
import { addJobNote, NOTE_MAX } from '@/lib/computer-job-notes';
import { jobActivity } from '@/lib/computer-job-steps';

export const runtime = 'nodejs';

const jobIdSchema = z.string().min(1).max(64);
// Round 8, D2: the jobs the person was shown and confirmed for Stop all (1 to 50 job ids, which are uuids)
const confirmedSchema = z.array(z.string().uuid()).min(1).max(STOP_CONFIRMED_MAX);

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional() }).strict(),
  z.object({ action: z.literal('stop'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional(), confirmedJobIds: confirmedSchema.optional() }).strict(),
  z.object({ action: z.literal('stop_all'), personId: z.string().min(1).max(255), isGuest: z.boolean().optional(), confirmedJobIds: confirmedSchema }).strict(),
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
 *  - `stop_all` (confirmedJobIds, round 8 D2; `stop` takes it too): ends ONLY the live jobs in the set the person confirmed (1 to 50 ids; ids over or unknown are skipped) on the FIRST dispatch:
 *    `{ ok: true, view, stopped: [ids], left: [ids of live jobs not in the set, still going] }`, kept as the command's outcome. The set is part of the command: the same command id with another set is 409 `command_reused`.
 *
 * Every action but `list` and `activity` needs the command id of that one tool call (header X-Computer-Command, a uuid; Brick derives it from the chat event, the action, the job and the call's number in the
 * turn, so a retried turn sends the same ids): the same id again answers what it came to and does nothing more (finding 4). 400 `{ ok: false, reason: 'command_missing' }` without one, 400
 * `{ ok: false, reason: 'command_reused' }` for an id used for another control.
 *
 * Every other refusal is HTTP 200 `{ ok: false, reason }`: `not_owner` (a guest, or not this Brick's owner), `not_found` (no such job on this Brick), and the
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
    const command = commandOf(request);
    if (body.action !== 'list' && body.action !== 'activity' && (!command || command === 'invalid'))
      return NextResponse.json({ ok: false, reason: 'command_missing', error: `Every control needs its own command id (${COMMAND_HEADER}, a uuid)` }, { status: 400 });
    const control = command && command !== 'invalid' ? command : undefined;
    const person = await resolveUsagePerson(body.personId, body.isGuest);
    if (person.lookupFailed) return NextResponse.json({ error: 'Could not tell who this was for, ask again', retry: true }, { status: 503 });
    // Only the Brick's owner, the same check as a start: a guest, someone else, or a bot in a room has nothing here
    const ownerId = person.personId;
    if (!ownerId || !(await brickOf(id, ownerId))) return NextResponse.json({ ok: false, reason: 'not_owner' });
    const answer = (result: { ok: boolean; reason?: string }) => NextResponse.json(result, { status: !result.ok && result.reason === 'command_reused' ? 400 : 200 });
    switch (body.action) {
      case 'list': {
        const view = await computerView(id, ownerId);
        return NextResponse.json(view ? { ok: true, view } : { ok: false, reason: 'not_owner' });
      }
      case 'stop':
      case 'stop_all': {
        const confirmed = body.confirmedJobIds ?? null;
        const stopped = confirmed ? await stopAll(id, ownerId, new Date(), control, confirmed) : await stopAll(id, ownerId, new Date(), control);
        if (stopped.ok) return NextResponse.json({ ok: true, view: stopped.view, ...(confirmed ? { stopped: stopped.stopped ?? [], left: stopped.left ?? [] } : {}) });
        // The same command id with another confirmed set: a conflict (round 8, D2)
        if (confirmed && stopped.reason === 'command_reused') return NextResponse.json({ ok: false, reason: 'command_reused' }, { status: 409 });
        return answer({ ok: false, reason: stopped.reason === 'not_found' ? 'not_owner' : stopped.reason });
      }
      case 'activity': {
        const activity = await jobActivity(id, ownerId, body.jobId);
        return NextResponse.json(activity.ok ? { ok: true, job: activity.job, steps: activity.steps } : { ok: false, reason: activity.reason });
      }
      case 'note': {
        const noted = await addJobNote(id, ownerId, body.jobId, body.text, new Date(), control);
        return noted.ok ? NextResponse.json({ ok: true, view: noted.view, note: noted.note }) : answer({ ok: false, reason: noted.reason });
      }
      case 'pause':
        return answer(await pauseJob(id, ownerId, body.jobId, new Date(), control));
      case 'resume':
        return answer(await resumeJob(id, ownerId, body.jobId, new Date(), control));
      case 'cancel':
        return answer(await cancelJob(id, ownerId, body.jobId, new Date(), control));
      case 'first':
        return answer(await moveJobFirst(id, ownerId, body.jobId, { pauseRunning: body.pauseRunning === true }, new Date(), control));
    }
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] A control of a computer job failed:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
