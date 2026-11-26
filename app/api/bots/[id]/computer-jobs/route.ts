import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { z } from 'zod';
import { requireServiceToken } from '@/lib/service-tokens';
import { resolveUsagePerson } from '@/lib/usage-person';
import { ackStart, canonicalStartKey, computerView, earlierUnconfirmedStart, refuseAttempt, registerStart, retireStartKey, startAnsweredBefore, startJob, startKeyHasJob, startedJobFor, storedStartAnswer, type Registration } from '@/lib/computer';
import { ISSUE_SKEW_MS, issuedOfKey, startAnswerBody } from '@/lib/computer-start-answer';
import { startStateOf } from '@/lib/computer-values';
import { ownerSpendAllowed } from '@/lib/spend-rules';
import { carryOnFrom, endedJobs, ENDED_MAX, retryCandidate } from '@/lib/computer-continue';
import { jobsNow } from '@/lib/computer-jobs-now';
import { prisma } from '@/lib/db';

export const runtime = 'nodejs';

// ONE title for the start (POST): trimmed first, then at least one character and at most 200 (the title as a start stores it)
const titleSchema = z.string().trim().min(1).max(200);

// The game's own key for ONE start attempt (a uuid): sent with the start as the REQUEST HEADER `X-Computer-Start-Attempt` (never a body field: the body is strict, so a new field would refuse every start on an Orbit
// that lacks it) and with every look for it as the query `attempt`. Letters, digits, `_` and `-`, so it is the same text everywhere it is written
const START_ATTEMPT_HEADER = 'x-computer-start-attempt';
// The game says it acks the start (a second header, so the body stays strict): `X-Computer-Start-Acks: 1`. Only with it, and with a key, is the job made unconfirmed (see `earlier`)
const START_ACKS_HEADER = 'x-computer-start-acks';
const startKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
// "Try again" of an ended job (piece 8): the job to carry on, as a THIRD header (the body stays strict, so an Orbit without this reads an ordinary fresh start): `X-Computer-Continues: <job id>`.
// Orbit decides from its own record whether the new job carries on in that job's conversation (lib/computer-continue); a header that is no job id is refused like a bad key
const CONTINUES_HEADER = 'x-computer-continues';
const jobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

// The game confirms it has the answer of a start (an `action` of the same URL, so the start's own body stays strict): `{ action: 'start-ack', userId, isGuest?, attempt }`
const ackSchema = z.object({ action: z.literal('start-ack'), userId: z.string().min(1).max(255), isGuest: z.boolean().optional(), attempt: startKeySchema }).strict();
// Round 8 (Opus's ruling on CodeRabbit's pass of game 24dea75c): the game gives up on a key of an earlier, DIFFERENT ask that Orbit never answered: `{ action: 'start-retire', userId, isGuest?, attempt }`
const retireSchema = z.object({ action: z.literal('start-retire'), userId: z.string().min(1).max(255), isGuest: z.boolean().optional(), attempt: startKeySchema }).strict();

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
 * With `ended=N` (1 to 5; more is read as 5) it also answers `ended: [{ id, title, how, endedAt, continuable }]`: the person's ended jobs on this Brick, newest first, `continuable` when "try again" would carry it on
 * (the same test as the start's, lib/computer-continue), so Brick can ask "Which job?" (round 8, E). Someone else's Brick or a guest: `ended: []`. Anything else as `ended` is 400.
 * With `jobs=1` it also answers `jobs: { live, ended }` (lib/computer-jobs-now): this person's jobs on this Brick that are working, waiting for them or in line now (title, status, queuedFor, waitingFor, control, step,
 * askedAt, startedAt), and the latest few that ended within a week, newest first (title, status, endedBy, endedAt, file names, and for one that could not go on its cleaned reason). The Brick is told these with every
 * message, so it never says a job is running when none is, or that a job that finished never ran. Someone else's Brick or a guest: `jobs: { live: [], ended: [] }`; who it was for could not be looked up: 503 `{ retry: true }`.
 * With `retry=1` it also answers `retry: { id, title, how, endedAt, toldAt } | null`: the person's latest ended job on this Brick that "try again" would carry on in its own conversation (piece 8, lib/computer-continue), or null. The game names it back with the start (header `X-Computer-Continues`), and the start decides again.
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
    // Round 8, E: how many ended jobs to list (`ended=N`)
    const endedRaw = request.nextUrl.searchParams.get('ended');
    const endedCount = endedRaw === null ? null : /^[1-9][0-9]{0,2}$/.test(endedRaw) ? Math.min(ENDED_MAX, Number(endedRaw)) : NaN;
    if (endedCount !== null && Number.isNaN(endedCount)) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const person = await resolveUsagePerson(userId, request.nextUrl.searchParams.get('isGuest') === 'true');
    // Who this was for could not be looked up just now: "no job reached Orbit" is NOT known, and answering it would let the caller think nothing was made. The same word as the meter's events: nothing is answered
    // but `retry` (503), and the caller treats it as unknown, never as a miss
    // The Brick chat audit (26 Nov): what the Brick is told with every message about its jobs, live and lately ended (`jobs=1`). A lookup that failed is not "no jobs": it is the same retryable answer
    const wantsJobs = request.nextUrl.searchParams.get('jobs') === '1';
    if ((asked || wantsJobs) && person.lookupFailed) return NextResponse.json({ error: 'Could not tell who this was for, ask again', retry: true }, { status: 503 });
    const view = person.personId ? await computerView(id, person.personId) : null;
    // Only when asked: a guest, someone else's Brick or one that is not this person's has no job of theirs to find (only the owner starts work on a computer), so nothing is looked for there
    // GPT eighth note, A2: a key is known by the first key of its identity (a redelivery under another time prefix is the same start)
    const askedKey = asked?.success && person.personId ? await canonicalStartKey(id, person.personId, asked.data) : asked?.success ? asked.data : null;
    const found = asked?.success && askedKey ? (person.personId && view ? await startedJobFor(id, person.personId, askedKey) : null) : undefined;
    // A look is READ ONLY: it confirms nothing (its reply can be lost on the way back, and a start the game never received an answer of must stay unconfirmed). Only the game's own `start-ack` confirms a start
    const started = found && !('inProgress' in found) && asked?.success ? { ...found, attempt: askedKey ?? asked.data, state: startStateOf(found.status) } : found;
    // A start with this key is still going on (it holds its mark until its job is saved): no job has reached Orbit YET and one still can, so this is not a miss either. The same word as a failed lookup: ask again
    if (started && 'inProgress' in started) return NextResponse.json({ error: 'A start of this job is still going on, ask again', retry: true, inProgress: true }, { status: 503 });
    const wantsRetry = request.nextUrl.searchParams.get('retry') === '1';
    const extra = {
      ...(started === undefined ? {} : { started }),
      ...(wantsRetry ? { retry: view && person.personId ? await retryCandidate(id, person.personId) : null } : {}),
      ...(endedCount !== null ? { ended: view && person.personId ? await endedJobs(id, person.personId, endedCount) : [] } : {}),
      ...(wantsJobs ? { jobs: view && person.personId ? await jobsNow(id, person.personId) : { live: [], ended: [] } } : {}),
    };
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
 * With the header `X-Computer-Continues: <job id>` ("try again", piece 8) the new job carries on in that ended job's agent conversation when Orbit's record says it may (it failed, ours or the agent's own, or we ended it, it has a
 * conversation, and nothing carries it on yet), and the answer says `continued: true`. A job that already carries it on is the answer (one per ended job, ever). It is a NEW job: its own reservation, receipt, key and
 * attempt, and every guard of a start applies. When the named job cannot be carried on, NOTHING is made or reserved (GPT round 6, finding 6): `{ ok: false, reason: 'cannot_continue', why, job? }`, `why` one of
 * not_found, not_theirs, live, not_continuable, no_conversation, and `job` = `{ title, status, endedBy }` of the person's own named job (never for not_found / not_theirs). Brick says why and offers "Start a new job":
 * an ordinary start under a NEW key without this header.
 *
 * With the header `X-Computer-Start-Acks: 1` (and a key) the start says the game confirms it got the answer: the job is made unconfirmed, and until the game confirms it (`POST /api/bots/:id/computer-jobs` { action: 'start-ack', userId, isGuest?, attempt } -> 200 { ok: true, acked }, `acked` = that key has a job of this person on this Brick, now confirmed; idempotent; an unknown key, another person's or another Brick's changes nothing; a keyed look never confirms) a start under ANOTHER key for this person on this Brick makes nothing and answers HTTP 200 `{ ok: false, reason: 'earlier', job: { id, status, state, attempt } }` naming the OLDEST such job and the key it was made under (decided under the person's lock in the transaction that makes the job). `earlier` is not in `START_REFUSALS`: it is the job the game asked for earlier, not a refusal of this ask, and it confirms nothing. A start without the header is confirmed when it is made, as before.
 *
 * Every refusal is HTTP 200 `{ ok: false, reason }` with a reason from `START_REFUSALS` (lib/computer-values): Orbit never answers a start with 429 or another error status for a refusal, so a 429 is an intermediary's and the outcome of the start is not known (look it up by its key).
 *
 * `POST { action: 'start-retire', userId, isGuest?, attempt }` (round 8): the game gives up on a key of an earlier, DIFFERENT ask that it holds open and Orbit never answered. Under the person's lock a key with no attempt, or
 * whose start came to nothing, is retired: 200 `{ ok: true, retired: true }`, and every later send of it is `{ ok: false, reason: 'retired_by_game' }` (nothing is made). A key Orbit did see: 200
 * `{ ok: true, retired: false, answer }`, the answer a send of it would get now (read only): the game follows that start.
 *
 * Round 8 (GPT's seventh note, Opus's design A1/A2), for a start with `X-Computer-Start-Acks: 1`:
 *  - The key MUST carry its issue time (`t<ms base36>-<rest>`, the moment of the person's message): 400 without one, or one more than 5 minutes in the future.
 *  - The start is REGISTERED (its attempt, with the request's own moment) before anything else is asked, the spending rule included: a later request under another key that decides meanwhile waits for it, and a look for
 *    this key says it is going on.
 *  - Every refusal is kept on the key: a retry of it gets the same body again (never `expired`).
 *  - `retired`: the key already made a job whose record was removed since. Terminal: the request already ran.
 *  - `stale_consent`: the key was issued longer ago than 6 hours and Orbit holds no live record of it: nothing is made or reserved; Brick asks the person whether to start it now (a new message, a new key).
 *  - A key whose attempt ended with no job, within those 6 hours, is reopened under the SAME key (never answered `expired`): a job made after the key was issued answers it, or it makes its own.
 *
 * Auth: service token only.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    requireServiceToken(request);
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  // Round 8, A1: the start's own moment, before its body is read. Its attempt carries it, and every "made after this one began" compares with it, however long anything below is delayed
  const began = new Date();
  let registration: Registration | null = null;
  let handedOn = false;
  let key: { id: string; personId: string; startKey: string } | null = null;
  try {
    const { id } = await params;
    const raw = await request.json().catch(() => null);
    // The game gives up on a key it holds open for an earlier, different ask (round 8): retired, or the answer Orbit has for it
    if (raw !== null && typeof raw === 'object' && (raw as { action?: unknown }).action === 'start-retire') {
      const asked = retireSchema.safeParse(raw);
      if (!asked.success) return NextResponse.json({ error: 'Invalid input data', details: asked.error.issues }, { status: 400 });
      const who = await resolveUsagePerson(asked.data.userId, asked.data.isGuest);
      if (who.lookupFailed) return NextResponse.json({ error: 'Could not tell who this was for, ask again', retry: true }, { status: 503 });
      // A guest has no Brick computer and no start: there is nothing to follow
      if (!who.personId) return NextResponse.json({ ok: true, retired: true });
      return NextResponse.json({ ok: true, ...(await retireStartKey(id, who.personId, await canonicalStartKey(id, who.personId, asked.data.attempt))) });
    }
    // The game confirms it has the answer of a start it made: told apart by its `action`
    if (raw !== null && typeof raw === 'object' && (raw as { action?: unknown }).action !== undefined) {
      const acked = ackSchema.safeParse(raw);
      if (!acked.success) return NextResponse.json({ error: 'Invalid input data', details: acked.error.issues }, { status: 400 });
      const who = await resolveUsagePerson(acked.data.userId, acked.data.isGuest);
      // Who this was for could not be looked up just now: nothing is confirmed, and the caller asks again
      if (who.lookupFailed) return NextResponse.json({ error: 'Could not tell who this was for, ask again', retry: true }, { status: 503 });
      if (!who.personId) return NextResponse.json({ ok: true, acked: false });
      return NextResponse.json({ ok: true, acked: await ackStart(id, who.personId, await canonicalStartKey(id, who.personId, acked.data.attempt)) });
    }
    const parsed = bodySchema.safeParse(raw);
    if (!parsed.success) return NextResponse.json({ error: 'Invalid input data', details: parsed.error.issues }, { status: 400 });
    // The key of this one start, from its header: one that is not a key is refused (a start that cannot be looked up again must not begin), none is a start as before
    const sentKey = request.headers.get(START_ATTEMPT_HEADER);
    const attempt = sentKey === null ? null : startKeySchema.safeParse(sentKey);
    if (attempt && !attempt.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    const sentContinues = request.headers.get(CONTINUES_HEADER);
    const continues = sentContinues === null ? null : jobIdSchema.safeParse(sentContinues);
    if (continues && !continues.success) return NextResponse.json({ error: 'Invalid input data' }, { status: 400 });
    // A start that says the game confirms its answers, retried under a NEW key while an earlier start of this person on this Brick is still unconfirmed, is answered with that job BEFORE the spend rule is asked: the earlier job may
    // have used what a chat-stated rule leaves, and the answer the game is owed is the job it asked for, never a false `rule`. (The decision that makes or refuses a job is still the one under the person's lock in `startJob`.)
    const acking = attempt?.success === true && request.headers.get(START_ACKS_HEADER) === '1';
    // Round 8, A2: a start that acks carries the moment the person gave consent in its key. None, or one in the future, is not a start that can be held to its consent
    const issued = acking && attempt?.success ? issuedOfKey(attempt.data) : null;
    if (acking && (!issued || issued.getTime() > began.getTime() + ISSUE_SKEW_MS)) return NextResponse.json({ error: 'Invalid input data', reason: 'untimed_key' }, { status: 400 });
    const person = await resolveUsagePerson(parsed.data.userId, parsed.data.isGuest);
    // Who this was for could not be looked up just now: the same retryable answer as an acknowledgement gets, never a terminal `not_owner` for a key whose job may already exist (CodeRabbit on #1025, I1)
    if (person.lookupFailed) return NextResponse.json({ error: 'Could not tell who this was for, ask again', retry: true }, { status: 503 });
    // A guest never has a Brick computer: a Brick belongs to an account
    if (!person.personId) return NextResponse.json({ ok: false, reason: 'not_owner' });
    // GPT eighth note, A2: the start is known by the first key Orbit saw with its identity (a redelivery of one event under another time prefix is the same start, judged from the first consent time)
    const startKey = attempt?.success ? await canonicalStartKey(id, person.personId, attempt.data) : null;
    const startIssued = acking && startKey ? (issuedOfKey(startKey) ?? issued) : null;
    // Round 8, A1: registered FIRST, before every look and the spending rule below, so no later request can overtake it. A2: a key decided for good is answered here (its kept refusal, `retired`, `stale_consent`)
    if (acking && startKey && startIssued) {
      key = { id, personId: person.personId, startKey };
      const registered = await registerStart(id, person.personId, startKey, began, startIssued);
      if ('answer' in registered) return NextResponse.json(startAnswerBody(registered.answer));
      registration = registered.registration;
    }
    // A refusal decided here is kept on the key (round 8, A1), so its retry is the same answer
    const refused = async (body: Record<string, unknown>) => {
      if (key) {
        const kept = await refuseAttempt(key.id, key.personId, key.startKey, body);
        // The refusal is given as final only when it is on the key, or another request decided the key first (then its stored answer is the key's answer). A write that failed leaves the key open with no answer: a retry could
        // be allowed by the rule by then and start a job, so this is not a terminal answer; the game asks again (CodeRabbit on #1025)
        if (kept === 'failed') return NextResponse.json({ error: 'Could not keep the answer, ask again', retry: true }, { status: 503 });
        if (kept === 'decided') {
          // The complete answer on record, the key's own job included (another request may have made it since this one looked): never this request's local refusal for a key that has a job, and when nothing can be read, a retry (CodeRabbit on #1025, N2)
          const decided = await storedStartAnswer(key.id, key.personId, key.startKey);
          if (decided) return NextResponse.json(decided);
          return NextResponse.json({ error: 'Could not read the answer on record, ask again', retry: true }, { status: 503 });
        }
      }
      return NextResponse.json(body);
    };
    // Finding 1 (GPT round 6): a key that was answered before with another start's job gets that same answer again, first: after the job was acknowledged, ended, or the game forgot the key, never a job of its own
    if (startKey) {
      const answered = await startAnsweredBefore(id, person.personId, startKey);
      if (answered) return NextResponse.json(startAnswerBody(answered));
    }
    if (acking && startKey) {
      const earlier = await earlierUnconfirmedStart(id, person.personId, startKey);
      if (earlier) return NextResponse.json({ ok: false, reason: 'earlier', job: earlier });
    }
    // "Try again" is resolved FIRST: a named job that cannot be carried on is `cannot_continue` (with the way to start a fresh job), whatever the person's spending rule leaves; one already carried on keeps its earlier answer
    // (the spend look below lets it through); only a continuation that would be MADE is held to the rule (CodeRabbit on #1025, 35). A start that names a run is answered by the run's own job first, so it is left to the start
    // A replay of a key that already made its job is not a new "try again": the job it made answers it (in `startJob`), even when the job it continued has been deleted since (CodeRabbit on #1025)
    if (continues?.success && !parsed.data.runId && !(startKey && (await startKeyHasJob(id, person.personId, startKey)))) {
      const carry = await carryOnFrom(id, person.personId, continues.data);
      if ('fresh' in carry) return refused({ ok: false, reason: 'cannot_continue', why: carry.fresh, ...(carry.job ? { job: carry.job } : {}) });
    }
    // A rule the person said in chat ("no more than $1 a month", "only my own accounts") is held before a job exists, so Brick can say so at once
    const ruled = await ownerSpendAllowed(id, person.personId, 'computer', new Date(), parsed.data.runId ?? null, startKey, continues?.success ? continues.data : null);
    if (!ruled.ok) return refused({ ok: false, reason: 'rule', rule: { id: ruled.ruleId, why: ruled.why, leftMicros: ruled.leftMicros, words: ruled.words } });
    handedOn = true;
    const started = await startJob({
      botId: id,
      personId: person.personId,
      title: parsed.data.title,
      brief: parsed.data.brief,
      writes: parsed.data.writes,
      runId: parsed.data.runId,
      startKey: startKey ?? undefined,
      acks: acking,
      plan: parsed.data.plan,
      origin: parsed.data.origin ?? null,
      continuesJobId: continues?.success ? continues.data : null,
      began,
      ...(registration ? { registration } : {}),
    });
    // The refusal could not be kept on the key: nothing final is answered, the game asks again (CodeRabbit on #1025, I8)
    if (!started.ok && started.reason === 'not_kept') return NextResponse.json({ error: 'Could not keep the answer, ask again', retry: true }, { status: 503 });
    return NextResponse.json(startAnswerBody(started));
  } catch (error) {
    // A registered start that failed before it was handed to the start lets its attempt go (only when this request made it): it is asked again under the same key and reopened
    if (registration?.opened && key && !handedOn) await closeRegistered(key);
    Sentry.captureException(error, { tags: { area: 'computer' } });
    console.error('[Computer] Could not start a job:', error instanceof Error ? error.message : 'unknown');
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  } finally {
    await registration?.release();
  }
}

/** A registered start that failed before its decision: its attempt is let go (state `expired`, so a retry of the key reopens it). Never throws. */
const closeRegistered = (key: { id: string; personId: string; startKey: string }) =>
  prisma.computerStartAttempt.updateMany({ where: { botId: key.id, personId: key.personId, startKey: key.startKey, state: 'open' }, data: { state: 'expired' } }).catch(() => undefined);
