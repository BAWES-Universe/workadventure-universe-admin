import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { computerView, startJob, startedJobFor } from '@/lib/computer';
import { ownerSpendAllowed } from '@/lib/spend-rules';

export const runtime = 'nodejs';

// Whether a start that timed out on the bot server's side reached Orbit: the chat it began in, its title and how long ago at most (an elapsed time, so no two clocks are compared)
const startedSchema = z.object({
  originRef: z.string().min(1).max(255),
  title: z.string().min(1).max(200),
  sinceSeconds: z.coerce.number().int().min(1).max(600),
});

const bodySchema = z
  .object({
    userId: z.string().min(1).max(255),
    isGuest: z.boolean().optional(),
    title: z.string().trim().min(1).max(200),
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
 * Answers { available, on, busy } (busy: a job holds it or waits in line). With `originRef` (and `title`, `sinceSeconds`) it also answers `started: { id, status } | null`: the newest job of this Brick for this
 * person that began in that direct chat with that title, made within `sinceSeconds` by Orbit's own clock, so a start that timed out on the caller's side can be told from one that did not reach Orbit. A caller that
 * sends none of them gets no `started`. Auth: service token only.
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
    const asked = request.nextUrl.searchParams.get('originRef') === null ? null : startedSchema.safeParse({ originRef: request.nextUrl.searchParams.get('originRef'), title: request.nextUrl.searchParams.get('title'), sinceSeconds: request.nextUrl.searchParams.get('sinceSeconds') });
    if (asked && !asked.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const person = await resolveUsagePerson(userId, request.nextUrl.searchParams.get('isGuest') === 'true');
    const view = person.personId ? await computerView(id, person.personId) : null;
    // Only when asked: a guest, or someone else's Brick, never has a job to find
    const started = asked?.success ? (person.personId ? await startedJobFor(id, person.personId, asked.data) : null) : undefined;
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
 * POST /api/bots/:id/computer-jobs { userId, isGuest?, title, writes?, runId?, plan?, origin? }
 * The bot server starts a job on a Brick's computer (game #2000), after it chose the computer as the way (an app that can do it for
 * less wakes no computer: that choice is made before this call, and this call is the only thing that can make or wake a machine).
 * Only the Brick's owner starts work on it: whoever else is talking to the Brick gets `not_owner`. Answers with the job and why
 * it waits if it does: `turn` (another job is writing), `allowance` (the person's own is used up: "Ask for more"), `busy` or
 * `pool` (wait in line, nothing to ask for), or `{ ok: false, reason }` when it cannot start at all (`rule`: a rule the person said in chat does not let it spend, with the rule's own words). With a `runId` (a run of the
 * person's goal or task on this Brick) the run starts one job, ever: asked again it answers with that job; another's run is `no_run`.
 * With a `plan` (the connected app the Brick weighed, about how many steps, and why it cannot) Orbit works out which way costs least: when the app does,
 * it answers `{ ok: false, reason: 'cheaper_route', app }` and starts nothing.
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
    const person = await resolveUsagePerson(parsed.data.userId, parsed.data.isGuest);
    // A guest never has a Brick computer: a Brick belongs to an account
    if (!person.personId) return NextResponse.json({ ok: false, reason: 'not_owner' });
    // A rule the person said in chat ("no more than $1 a month", "only my own accounts") is held before a job exists, so Brick can say so at once
    const ruled = await ownerSpendAllowed(id, person.personId, 'computer', new Date(), parsed.data.runId ?? null);
    if (!ruled.ok) return NextResponse.json({ ok: false, reason: 'rule', rule: { id: ruled.ruleId, why: ruled.why, leftMicros: ruled.leftMicros, words: ruled.words } });
    const started = await startJob({ botId: id, personId: person.personId, title: parsed.data.title, brief: parsed.data.brief, writes: parsed.data.writes, runId: parsed.data.runId, plan: parsed.data.plan, origin: parsed.data.origin ?? null });
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
