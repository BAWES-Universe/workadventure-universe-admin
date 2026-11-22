import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { computerView, startJob, startedJobFor } from '@/lib/computer';
import { startStateOf } from '@/lib/computer-values';
import { ownerSpendAllowed } from '@/lib/spend-rules';

export const runtime = 'nodejs';

// ONE title for the start (POST): trimmed first, then at least one character and at most 200 (the title as a start stores it)
const titleSchema = z.string().trim().min(1).max(200);

// The game's own key for ONE start attempt (a uuid): sent with the start as the REQUEST HEADER `X-Computer-Start-Attempt` (never a body field: the body is strict, so a new field would refuse every start on an Orbit
// that lacks it) and with every look for it as the query `attempt`. Letters, digits, `_` and `-`, so it is the same text everywhere it is written
const START_ATTEMPT_HEADER = 'x-computer-start-attempt';
const startKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

const bodySchema = z
  .object({
    userId: z.string().min(1).max(255),
    isGuest: z.boolean().optional(),
    title: titleSchema,
    // The task in the person's words, for the agent on the computer only (never shown)
    brief: z.string().max(4000).optional(),
    writes: z.boolean().optional(),
    // The run of a goal or task that asks for the computer (game #2002): a run handed out again finds its job and never starts a second
    runId: z.string().min(1).max(36).optional(),
    // The way the Brick weighed (never a price): the connected app that could seem to do the job, about how many steps it would take, and why it cannot
    plan: z
      .object({ app: z.string().trim().max(120).nullish(), steps: z.number().int().min(1).max(10000).nullish(), appCannot: z.string().trim().max(300).nullish() })
      .strict()
      .optional(),
    // The conversation the job began in. Only a direct chat can start computer work (a Brick standing in a room never uses its owner's computer for anyone), so
    // anything but `dm` is refused. The result goes back to that conversation and nowhere else.
    origin: z.object({ kind: z.literal('dm'), ref: z.string().min(1).max(255) }).strict().optional(),
  })
  .strict();

/**
 * GET /api/bots/:id/computer-jobs?userId=&isGuest= - whether this Brick's computer is there for its owner to use, so the bot server only
 * offers the computer when it is on. Read only: it never makes or wakes anything. Someone else's Brick, or a guest: `{ on: false }`.
 * Answers { available, on, busy } (busy: a job holds it or waits in line). With `attempt` (the key the game sent with a start, as the header `X-Computer-Start-Attempt`) it also answers `started: { id, status, state, attempt } | null` (`attempt` is the one asked, echoed; `state` is the one shared reading of `status`: live, done or ended): the job THAT start made, for as long as the job exists (the key is kept on the job itself: there is no time after which it is forgotten), or null when that start made none. The key alone says
 * which start, so a job of the same chat or title is never answered for it. While a start with that key is still going on (its job is not saved yet) the answer is 503 `{ retry: true, inProgress: true }`, and so when who it was for could not be
 * looked up just now (503 `{ retry: true }`): never `started: null`, which says no job was made. The caller treats both as "not known" and asks again (a start repeated with the same key never makes a second job). A caller that sends no `attempt` gets no `started`.
 * Auth: service token only.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const { id } = await params;
    const userId = request.nextUrl.searchParams.get('userId');
    if (!userId) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    // `attempt` asks whether THAT start reached Orbit: the key alone says which start (never a job of the same chat or title). Without it the legacy answer
    const startKey = request.nextUrl.searchParams.get('attempt');
    const asked = startKey === null ? null : startKeySchema.safeParse(startKey);
    if (asked && !asked.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const person = await resolveUsagePerson(userId, request.nextUrl.searchParams.get('isGuest') === 'true');
    // Who this was for could not be looked up just now: "no job reached Orbit" is NOT known, and answering it would let the caller think nothing was made. The same word as the meter's events: nothing is answered
    // but `retry` (503), and the caller treats it as unknown, never as a miss
    if (asked && person.lookupFailed) return NextResponse.json({ error: 'Could not tell who this was for, ask again', retry: true }, { status: 503 });
    const view = person.personId ? await computerView(id, person.personId) : null;
    // Only when asked: a guest, someone else's Brick or one that is not this person's has no job of theirs to find (only the owner starts work on a computer), so nothing is looked for there
    const found = asked?.success ? (person.personId && view ? await startedJobFor(id, person.personId, asked.data) : null) : undefined;
    const started = found && !('inProgress' in found) && asked?.success ? { ...found, attempt: asked.data, state: startStateOf(found.status) } : found;
    // A start with this key is still going on (it holds its mark until its job is saved): no job has reached Orbit YET and one still can, so this is not a miss either. The same word as a failed lookup: ask again
    if (started && 'inProgress' in started) return NextResponse.json({ error: 'A start of this job is still going on, ask again', retry: true, inProgress: true }, { status: 503 });
    const extra = started === undefined ? {} : { started };
    if (!view) return NextResponse.json({ available: false, on: false, busy: false, ...extra });
    return NextResponse.json({ available: view.available, on: view.on, busy: view.job !== null || view.queued.length > 0, ...extra });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not read a computer:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

/**
 * POST /api/bots/:id/computer-jobs { userId, isGuest?, title, writes?, runId?, plan?, origin? } + the optional header `X-Computer-Start-Attempt`
 * The bot server starts a job on a Brick's computer (game #2000), after it chose the computer as the way (an app that can do it for
 * less wakes no computer: that choice is made before this call, and this call is the only thing that can make or wake a machine).
 * Only the Brick's owner starts work on it: whoever else is talking to the Brick gets `not_owner`. Answers with the job and why
 * it waits if it does: `turn` (another job is writing), `allowance` (the person's own is used up: "Ask for more"), `busy` or
 * `pool` (wait in line, nothing to ask for), or `{ ok: false, reason }` when it cannot start at all (`rule`: a rule the person said in chat does not let it spend, with the rule's own words). With a `runId` (a run of the
 * person's goal or task on this Brick) the run starts one job, ever: asked again it answers with that job; another's run is `no_run`. With the header `X-Computer-Start-Attempt` (one uuid per start the game makes) the start makes one job, ever: sent again with the same key it
 * answers with the job that key made (or the same refusal), never a second job.
 * With a `plan` (the connected app the Brick weighed, about how many steps, and why it cannot) Orbit works out which way costs least: when the app does,
 * it answers `{ ok: false, reason: 'cheaper_route', app }` and starts nothing.
 *
 * Every refusal is HTTP 200 `{ ok: false, reason }` with a reason from `START_REFUSALS` (lib/computer-values): Orbit never answers a start with 429 or another error status for a refusal, so a 429 is an intermediary's and the outcome of the start is not known (look it up by its key).
 *
 * Auth: service token only.
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
    // The key of this one start, from its header: one that is not a key is refused (a start that cannot be looked up again must not begin), none is a start as before
    const sentKey = request.headers.get(START_ATTEMPT_HEADER);
    const attempt = sentKey === null ? null : startKeySchema.safeParse(sentKey);
    if (attempt && !attempt.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const person = await resolveUsagePerson(parsed.data.userId, parsed.data.isGuest);
    // A guest never has a Brick computer: a Brick belongs to an account
    if (!person.personId) return NextResponse.json({ ok: false, reason: 'not_owner' });
    // A rule the person said in chat ("no more than $1 a month", "only my own accounts") is held before a job exists, so Brick can say so at once
    const ruled = await ownerSpendAllowed(id, person.personId, 'computer', new Date(), parsed.data.runId ?? null, attempt?.success ? attempt.data : null);
    if (!ruled.ok) return NextResponse.json({ ok: false, reason: 'rule', rule: { id: ruled.ruleId, why: ruled.why, leftMicros: ruled.leftMicros, words: ruled.words } });
    const started = await startJob({ botId: id, personId: person.personId, title: parsed.data.title, brief: parsed.data.brief, writes: parsed.data.writes, runId: parsed.data.runId, startKey: attempt?.success ? attempt.data : undefined, plan: parsed.data.plan, origin: parsed.data.origin ?? null });
    if (started.ok) return NextResponse.json({ ok: true, job: started.job, restoredFrom: started.restoredFrom });
    // A rule that stopped it on the try itself (the pre-check only asks for a first millionth): the same shape as above, with the rule's words
    if (started.reason === 'rule') return NextResponse.json({ ok: false, reason: 'rule', rule: { id: null, why: null, leftMicros: null, words: started.words } });
    // A connected app would do it for less: nothing was started, and the Brick is told which one to use
    if (started.reason === 'cheaper_route') return NextResponse.json({ ok: false, reason: 'cheaper_route', app: started.app });
    return NextResponse.json({ ok: false, reason: started.reason });
  } catch (error) {
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not start a job:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
