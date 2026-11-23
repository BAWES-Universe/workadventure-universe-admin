import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';
import { lockPool, releaseRoom, releaseRoomIn, reserveRoom, settleRoom } from '@/lib/meter-allowance';
import { revokeJobTokens, verifyJobToken } from '@/lib/computer-token';
import { givenBackJob } from '@/lib/computer-values';
import { drawComputerCredit, giveBackComputerCredit } from '@/lib/computer-credit';
import { CALL_IN_LAST_STRETCH, callInLastStretch } from '@/lib/computer-stretch';
import { extendHoldIn, leaseUntil } from '@/lib/computer-lease';
import { routeIsPaused } from '@/lib/computer-route-pause';
import { POOL_BUSY_WORDS } from '@/lib/task-receipt-words';
import { tellSentry } from '@/lib/computer-alerts';
import { ORBIT_SOURCE, POOL_CUTOFF_CALL, admitLockKey, cutoffLockKey, hasCallAdmission, hasFinishIntent, hasOwnKeyCall, hasPoolCutoff, recordCallAdmission, recordTurnAdmitted, authorizeOwnKeyCall, recordPoolCutoff, recordPoolRefusal, retirePoolRefusals } from '@/lib/computer-faults';

/**
 * A model call a Brick's computer makes (build handoff v2, section 5): room is taken BEFORE the call, and what it really cost is
 * written and settled after, whether it finished, was cut off or failed.
 *
 * Orbit decides and keeps the books; the call itself runs where the AI providers already are (the bot server, which has every
 * provider's way of talking, its price list and its key). That side asks here first:
 *  1. `authorizeModelCall`: the computer's key is checked against Orbit's records (the job still holds the machine, the key is
 *     for models, it is from the current control generation), and the room for this one call is reserved from the person's
 *     computer allowance, inside the pool. No room: the call is refused with the reason, and nothing was sent anywhere.
 *  2. The call runs.
 *  3. `settleModelCall`: the figures go to the books once (a retry adds nothing) and the room is settled to what it cost. A call
 *     whose price is unknown settles at the room that was held, never at 0.
 *  or `releaseModelCall` when nothing was sent.
 *
 * Whoever pays comes from Orbit's records, never from the computer: a call on the owner's own key costs the platform nothing and
 * takes no room from the pool, but is checked, counted and recorded the same way.
 */

const CALL_ID = /^[A-Za-z0-9_.:-]{1,80}$/;
const MAX_MICROS = 2_000_000_000;

// A function declaration (hoisted), so a module that is part of an import cycle still finds it while this one is loading
export function callRoomKey(jobId: string, callId: string): string {
  return `computer:call:${jobId}:${callId}`;
}

export type Authorized =
  | { ok: true; jobId: string; botId: string; personId: string; /** Null when the call is on the owner's own key: no room was taken. */ reservedMicros: number | null }
  /** The key is not good (any reason), or the call id is not one. The same answer, so nothing is learned from it. */
  | { ok: false; reason: 'refused' }
  /** The person's own computer allowance is used up: "Ask for more". */
  | { ok: false; reason: 'allowance' }
  /** Our pool, or the controls, have no room: nothing the person can ask for. `full` is true when the pool has no room even for the smallest call (the envelope is at its ceiling), when new work on the call's route is paused (our decision), or when the controls were never set up (our misconfiguration), so the relay can tell ours from a call refused for its own size. */
  | { ok: false; reason: 'pool'; full: boolean }
  /** A rule the person said in chat does not let this call take that much: the rule's own words, and nothing to ask more credit for. */
  | { ok: false; reason: 'rule'; ruleId: string; why: 'own_accounts' | 'cap'; leftMicros: number | null; words: string };

export async function authorizeModelCall(
  input: { token: string; callId: string; estimateMicros: number; payer: 'universe' | 'own-key'; /** The turn and the run of it the call is made for, when the relay knows them: a stop for our capacity that rests on this turn or an earlier one of the run is stale once a call is admitted for it. */ turn?: number | null; run?: string | null; /** The provider and route the call goes to, when the relay names it: new platform-funded work on a route that is failing for many people waits. */ route?: string | null },
  asked?: Date,
  /** How the end of a decided cutoff is run once the refusal is answered. The route hands over Next's `after` (it runs when the response has been sent, so the relay gets the refusal first); without it (a test, a caller with no response to wait for) the end is started in the background at once. */
  afterAnswer?: (task: () => Promise<void>) => void,
): Promise<Authorized> {
  // The time of this request, and (for what is decided after waiting for a lock) the time read again once the wait is over; a caller that fixes the time (the tests) fixes both
  const now = asked ?? new Date();
  const clock = (): Date => asked ?? new Date();
  if (!CALL_ID.test(input.callId)) return { ok: false, reason: 'refused' };
  const verified = await verifyJobToken(input.token, 'model', now);
  if (!verified.ok) return { ok: false, reason: 'refused' };
  const base = { jobId: verified.jobId, botId: verified.botId, personId: verified.personId };
  // The key this call was made with and the owner epoch it was made under: a refusal ends the job only while that key is still good and still the owner's (a delayed call of a worker that was replaced is refused alone)
  const from = { epoch: verified.epoch, tokenId: verified.tokenId };
  if (input.payer === 'own-key') {
    // No room is taken, but a call after the fence is refused all the same
    const still = await verifyJobToken(input.token, 'model', now);
    if (!still.ok || still.generation !== verified.generation) return { ok: false, reason: 'refused' };
    // A call on the person's own key leaves no room and no price: Orbit keeps one marker per job that one was authorized, so "authorized, its report not here yet" is never read as "no call at all" (which is ours, and
    // an own key is never given back as ours). A call is not authorized unless the marker is kept: one that could not be kept is refused (the relay asks again), as a call that is authorized and then forgotten would let
    // a cutoff for our own capacity read the job as one that never had a call
    try {
      // The whole decision is ONE transaction under the job's cutoff lock and the lock a finish's inference takes: the job is still on, no cutoff for our capacity is decided, no finish intent is kept, the key is still good
      // (looked at with the time read after the waits), and only then are the marker and the admission for the call's turn written. A call refused for any of these leaves no marker (there is no second look after the commit,
      // so nothing can refuse it after its marker was kept), and a job that was ended meanwhile does not authorize the call. A stop that is deciding at the same moment either finds the admission (and answers stale) or won (and this is refused)
      const kept = await authorizeOwnKeyCall(
        base.jobId,
        now,
        async (tx) => {
          const still = await verifyJobToken(input.token, 'model', clock(), tx);
          return still.ok && still.generation === verified.generation;
        },
        { turn: input.turn, run: input.run },
        clock,
      );
      if (!kept) return { ok: false, reason: 'refused' };
    } catch (error) {
      console.error('[Computer] Could not note an own-key call, so it is not authorized:', error instanceof Error ? error.message : 'unknown');
      return { ok: false, reason: 'refused' };
    }
    return { ok: true, ...base, reservedMicros: null };
  }
  if (!Number.isSafeInteger(input.estimateMicros) || input.estimateMicros <= 0 || input.estimateMicros > MAX_MICROS) return { ok: false, reason: 'refused' };
  // One provider failing for many people: nothing new is sent to it for now (nothing is held or charged). Never for a person's own key. A pause is OUR decision,
  // so it answers `full: true`: the relay records it as a confirmed fault of ours (pool_busy), never as the job's own doing
  // The pause gates only NEW call ids: a call that already holds its room (the same job, the same person, still held) is asked again by a retry, and is answered
  // with its own authorization whatever the route's state is now: it was authorized before the pause, and refusing its retry would make the relay record a fault of ours for a call that is going on
  if (input.route && !(await holdsItsRoom(base.jobId, input.callId, base.personId, now)) && (await routeIsPaused(input.route, now).catch(() => false))) {
    await refusedForPool(base.jobId, input.callId, input.route, now, afterAnswer, from);
    return { ok: false, reason: 'pool', full: true };
  }
  const room = await reserveRoom({ key: callRoomKey(base.jobId, input.callId), personId: base.personId, amountMicros: input.estimateMicros, botId: base.botId, jobId: base.jobId, newJob: false }, now);
  if (room.ok) {
    // The room may have waited for the pool's lock while the person took the machine: the key must still be good after it, or the room goes back. And a cutoff for our own capacity that was deciding at the same
    // moment either counted this room (and did not stop the job) or won (the key is no longer good): the room goes back, never both. A look that FAILS is the same answer as one that says no: the call is refused and
    // the room goes back, never held for a call that was not authorized
    // The key is looked at again by `authorizedPastCutoff`, with the time read after the room's wait for the pool's lock (and after the cutoff's, when there is one): a key that ran out meanwhile is no longer good
    const stands = await authorizedPastCutoff(base.jobId, input.callId, input.token, verified.generation, clock, { turn: input.turn, run: input.run }, base.personId, room.created ? null : base.personId).catch((error) => {
      console.error('[Computer] Could not look again at a call that was authorized:', error instanceof Error ? error.message : 'unknown');
      return false;
    });
    if (!stands) {
      // Only the room THIS request took goes back (asked again for a call that already holds its room, the hold is the first request's), and not even that one when another request was answered with this call's
      // authorization meanwhile: its call goes on with the room, and the room is released only when no request used it
      if (room.created) await giveBackUnusedRoom(base.jobId, input.callId, clock);
      return { ok: false, reason: 'refused' };
    }
    // Capacity is back: what was refused before it stops deciding the turns that come after
    await retirePoolRefusals(prisma, base.jobId).catch((error) => console.error('[Computer] Could not retire a recovered pool refusal:', error instanceof Error ? error.message : 'unknown'));
    return { ok: true, ...base, reservedMicros: room.reservation.amountMicros };
  }
  // A call refused for the person's own allowance or a rule they said ends the job right here, as a refused renewal does (stopped, by `allowance` or `rule`,
  // which is theirs): the agent's turns that fail on the refusal can then never end the job as ours and give back everything it ran before the limit
  if (room.reason === 'allowance') {
    await endForRefusal(base.jobId, { reason: 'allowance' }, now, from, { kind: 'call', micros: input.estimateMicros });
    return { ok: false, reason: 'allowance' };
  }
  if (room.reason === 'rule') {
    await endForRefusal(base.jobId, { reason: 'rule', words: room.words }, now, from, { kind: 'call', micros: input.estimateMicros });
    return { ok: false, reason: 'rule', ruleId: room.ruleId, why: room.why, leftMicros: room.leftMicros, words: room.words };
  }
  // Asked again for a call whose room was settled or lapsed: the first try is the call, and a second one is not another
  if (room.reason === 'closed' || room.reason === 'key_reused') return { ok: false, reason: 'refused' };
  // The controls were never set up (a setting the meter cannot work without is empty): that is OUR misconfiguration, never the job's. It is answered as ours (the pool, `full: true`), so the relay records it as a
  // confirmed fault of ours (pool_busy) and the job is given back, and Sentry is told. It is not a capacity refusal: no marker of one is kept and it never counts toward a cutoff
  if (room.reason === 'not_set') {
    await tellMeterNotSet(room.missing, now);
    return { ok: false, reason: 'pool', full: true };
  }
  // Only a pool with no room even for the smallest call (`full`) is OUR capacity. A call refused for its own SIZE (`full: false`), or for a setting that is missing, says nothing about it
  const ours = room.reason === 'pool' && room.full === true;
  if (ours) await refusedForPool(base.jobId, input.callId, input.route ?? null, now, afterAnswer, from);
  return { ok: false, reason: 'pool', full: ours };
}

/**
 * The creator of a call's room gives it back because the call does not stand, unless another request was answered with the call's authorization (see `admitAgain`): the look for that answer and the release are ONE step
 * under the call's lock, so a request cannot be answered between them. Never throws: a room that could not be given back is left to lapse, as before.
 */
async function giveBackUnusedRoom(jobId: string, callId: string, clock: () => Date): Promise<void> {
  // A look that fails once is tried again (the marker is looked for again each time: a request that was answered meanwhile keeps the room), so a call that was refused never leaves its room counted against the pool
  for (let attempt = 1; attempt <= GIVE_BACK_ATTEMPTS; attempt += 1) {
    try {
      await prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${admitLockKey(jobId, callId)}, 0))`;
          if (await hasCallAdmission(tx, jobId, callId)) return;
          await releaseRoomIn(tx, { key: callRoomKey(jobId, callId) }, clock());
        },
        { timeout: 15_000, maxWait: 15_000 },
      );
      return;
    } catch (error) {
      console.error('[Computer] Could not give back room:', error instanceof Error ? error.message : 'unknown');
      if (attempt < GIVE_BACK_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

/** How many times the release of an unused room is tried before it is left to lapse. */
const GIVE_BACK_ATTEMPTS = 3;

/** How often Sentry is told that the meter's controls are not set up: once, and again only after this long (every call of every job is refused for it, so a call each would flood it). */
const NOT_SET_ALERT_EVERY_MS = 15 * 60_000;
let lastNotSetAlert: number | null = null;

/** Forgets that Sentry was told the controls are not set up (for the tests). */
export function forgetMeterNotSetAlert(): void {
  lastNotSetAlert = null;
}

async function tellMeterNotSet(missing: readonly string[], now: Date): Promise<void> {
  const before = lastNotSetAlert;
  if (before !== null && Math.abs(now.getTime() - before) < NOT_SET_ALERT_EVERY_MS) return;
  // Taken before the alert is sent, so calls arriving together tell it once; given back when the alert could not be delivered, so the next call tells it
  lastNotSetAlert = now.getTime();
  await tellSentry(() => Sentry.captureMessage('The meter’s controls are not set up, so every model call of a computer is refused: this is ours to fix', { level: 'error', tags: { area: 'computer', step: 'meter_not_set' }, extra: { missing: [...missing] } })).catch(() => {
    lastNotSetAlert = before;
  });
}

/** How many calls of a job that has never had one authorized may be refused for our own capacity before the job is stopped as ours: its first turn (and one retry of it) found no room. */
export const POOL_REFUSALS_BEFORE_STOP = 2;

/**
 * A model call was refused for OUR capacity (the pool has no room, or its route is paused). For a job whose calls have ALL been refused so far (not one authorized, in any state) that is a confirmed fault of ours, kept by
 * Orbit itself (one row per call, so a retried call counts once) whatever the relay writes about it. Such a job that has now had `POOL_REFUSALS_BEFORE_STOP` refused is not going anywhere: every call it makes
 * is refused, and left alone it would spin on its person's allowance of time. It is stopped as `pool` (ours: its time given back, never counted, with the words the person is told). A job that had a
 * call authorized before is never stopped here: a refusal in the middle of its work is the relay's to tell, and the job's own renewal ends it if the pool stays full. Never throws: a refusal is answered whatever this does.
 */
async function refusedForPool(jobId: string, callId: string, route: string | null, now: Date, afterAnswer?: (task: () => Promise<void>) => void, from?: { epoch: number; tokenId: string }): Promise<void> {
  let cutoff = false;
  try {
    // One lock per job, held from the count to the moment the job's keys end, and DATABASE STEPS ONLY: no provider call and no other transaction is made while it is held (the end of the job is slow: it
    // cancels the agent's turn, hands files over, rests the machine). An authorization that is deciding at the same moment waits for it (`authorizedPastCutoff`), so the job is never stopped for a count of
    // zero authorized calls that a call authorized meanwhile made wrong, and a call authorized after the decision is refused
    cutoff = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0))`;
        // A job that is over (or not on the machine) is not decided about: a finish that ended it first stands, and a cutoff for a job nothing is running for would only end its keys again
        const job = await tx.computerJob.findUnique({ where: { id: jobId }, select: { status: true, ownerEpoch: true } });
        if (!job || (job.status !== 'running' && job.status !== 'waiting')) return false;
        // A refusal for a call of a worker that no longer owns the job (another claimed it since: the call's key ended, or was made under an older epoch) is the CALL's alone: it counts for nothing and decides nothing about the job
        if (from && (job.ownerEpoch !== from.epoch || (await tx.computerJobToken.count({ where: { id: from.tokenId, jobId, revokedAt: null } })) === 0)) return false;
        // Only a job whose calls have ALL been refused so far: one that had a call authorized before (a room held or priced, or one on the person's own key, which leaves only its marker) is left to the relay's own words
        if (await hadAuthorizedCall(tx, jobId)) return false;
        // Decided already (by a refusal that committed before this one): nothing to decide twice
        if (await hasPoolCutoff(tx, jobId)) return false;
        const refused = await recordPoolRefusal(tx, jobId, callId, { route, at: now });
        if (refused < POOL_REFUSALS_BEFORE_STOP) return false;
        // The decision is made durable here, under the lock and in the same transaction as the end of the job's keys: every key ends, so a call authorized after this commit finds its key dead and is refused, a
        // key made after it is refused (`mintJobToken`), and the job is ended from this record if nothing else ends it. Ending the job itself comes after
        await revokeJobTokens(jobId, now, undefined, tx);
        await recordPoolCutoff(tx, jobId, now);
        return true;
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
  } catch (error) {
    console.error('[Computer] Could not note a model call refused for our capacity:', error instanceof Error ? error.message : 'unknown');
    return;
  }
  // The slow end of the job (it cancels the agent's turn, hands files over with timeouts of up to 20 s, rests the machine) is NOT part of the answer: the refusal is answered first, so the relay never sees an authorize
  // that outlasts its own timeout for a call that was already refused (it could read that as something other than our pool being full, which is the fault the give-back stands on). The decision is durable
  // already (its record and the end of the job's keys are committed), every call the job makes is refused at its key, and `endStuckCutoffs` ends a decided job nothing else ended
  if (cutoff) endCutoffAfterAnswer(jobId, now, afterAnswer);
}

/** The ends of decided cutoffs that were started after their refusal was answered, so a test (or a shutdown) can wait for them. */
const cutoffEnds = new Set<Promise<void>>();
export const cutoffEndsFinished = (): Promise<void> => Promise.allSettled([...cutoffEnds]).then(() => undefined);

/**
 * Ends the job of a decided cutoff for our own capacity (as ours: given back, never counted), after the refusal was answered. Never throws and is never awaited by the request. When the caller says how to run
 * work after its response (`afterAnswer`: the route gives Next's `after`), the end waits for the response to be SENT, so the relay always gets the refusal first; otherwise it is started in the background at once.
 */
function endCutoffAfterAnswer(jobId: string, now: Date, afterAnswer?: (task: () => Promise<void>) => void): void {
  let finished: () => void = () => undefined;
  const work: Promise<void> = new Promise<void>((resolve) => {
    finished = resolve;
  });
  const run = async (): Promise<void> => {
    try {
      if (await endForRefusal(jobId, { reason: 'pool', words: POOL_BUSY_WORDS }, now)) return;
      // The decision is made and the keys are ended, but the job could not be: nothing retries it from a call (every call is refused at its key now), so the sweep ends it (`endStuckCutoffs`), and Sentry is told
      await tellSentry(() => Sentry.captureMessage('A computer job’s cutoff for our own capacity was decided but the job could not be ended: its keys are ended and the sweep ends it', { level: 'error', tags: { area: 'computer', step: 'pool_cutoff_end' }, extra: { jobId } })).catch(() => undefined);
    } catch {
      // Never throws: the sweep ends a decided job nothing ended
    } finally {
      cutoffEnds.delete(work);
      finished();
    }
  };
  cutoffEnds.add(work);
  if (afterAnswer) {
    try {
      afterAnswer(run);
    } catch {
      // `after` could not be set up (no request to follow): the end is started at once instead of being lost
      void run();
    }
  } else void run();
}

/** Whether a call of the job was ever authorized: a room held or settled for it (not one given back), a model call priced, or the marker of one on the person's own key. The three reads the cutoff and its sweep both stand on. */
async function hadAuthorizedCall(db: Pick<Prisma.TransactionClient, 'meterReservation' | 'meterEvent' | 'computerJobFault'>, jobId: string): Promise<boolean> {
  // A room that was given back (an admission that was rejected) is not a call that was authorized: only a room still held, or one that settled, is
  if ((await db.meterReservation.count({ where: { jobId, reservationKey: { startsWith: callRoomKey(jobId, '') }, state: { in: ['held', 'settled'] } } })) > 0) return true;
  if ((await db.meterEvent.count({ where: { jobId, kind: 'model_call' } })) > 0) return true;
  return hasOwnKeyCall(db, jobId);
}

/** How long after its last refusal a job whose keys ended is left to the request that decided its cutoff, which ends it itself, before the sweep does. */
const CUTOFF_GRACE_MS = 2 * 60_000;

/**
 * The sweep's half of the cutoff: a job still running or waiting that Orbit DECIDED to end for its own capacity (the record the cutoff keeps in the same transaction as the end of its keys) but which was never ended,
 * because the request that decided it could not end it (the database or the provider failed at that moment). Its lease and room keep renewing through the service token, so nothing else would ever end it. It is
 * ended as ours exactly as the cutoff would have (`pool`: its time given back, never counted); safe to run twice (a job that is over is left as it is). It stands on the record alone, never on the keys (a key
 * that was made after the decision cannot hold it back), and the record is read BEFORE the batch is cut, so a job that is not one never uses up a slot. Bounded by `batch`, the longest decided first. Returns how many it ended.
 */
export async function endStuckCutoffs(now: Date, batch: number): Promise<number> {
  const quiet = new Date(now.getTime() - CUTOFF_GRACE_MS);
  const jobs = await prisma.computerJob.findMany({
    where: { status: { in: ['running', 'waiting'] }, faults: { some: { callId: POOL_CUTOFF_CALL, source: ORBIT_SOURCE, at: { lte: quiet } } } },
    orderBy: { startedAt: 'asc' },
    take: batch,
    select: { id: true },
  });
  let ended = 0;
  for (const job of jobs) {
    try {
      if (await endForRefusal(job.id, { reason: 'pool', words: POOL_BUSY_WORDS }, now)) ended += 1;
    } catch (error) {
      console.error('[Computer] Could not end a job whose cutoff was decided:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return ended;
}

/**
 * Whether Orbit decided to end this job for its own capacity, and ends it as ours when it did (the sweep's unanswered pass asks first: a job that is waiting past its time for a person is not one that went quiet when we had
 * already cut it off). `decided` says it was one; `ended` whether it is over now (when it is not, the job is left to the next pass, never ended as anything else).
 */
export async function endIfCutoffDecided(jobId: string, now: Date): Promise<{ decided: boolean; ended: boolean }> {
  // Read under the job's cutoff lock: a cutoff that is deciding at this moment is waited for, never read as "not decided" and then lost to the end this caller makes
  const decided = await prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0))`;
      return hasPoolCutoff(tx, jobId);
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
  if (!decided) return { decided: false, ended: false };
  return { decided: true, ended: await endForRefusal(jobId, { reason: 'pool', words: POOL_BUSY_WORDS }, now) };
}

export { cutoffLockKey };

/**
 * Whether a call that was just authorized (its room held, or its marker kept) stands, decided under the job's cutoff lock: the one lock a cutoff for our own capacity, a finish intent and the making of a model key all
 * take, so exactly one of "stop" and "admit" wins. In ONE transaction (database steps only, no provider call): no cutoff is decided, no finish intent is kept, the key is still good (looked at with the time read AFTER the
 * waits: a key that ran out meanwhile, or one a stop revoked, is not good), and only then is the admission written (`turn_admitted`, with the turn and run when the relay names them). A stop that is deciding at the same
 * moment is waited for: if it won, the call is refused (its keys ended with it) and its room goes back; if this won, the stop finds the admission and answers stale. A wait that fails is a failed check (a no), never a
 * call authorized past a stop that may have won.
 */
async function authorizedPastCutoff(jobId: string, callId: string, token: string, generation: number, clock: () => Date, admitted: { turn?: number | null; run?: string | null } = {}, holder: string, replayOf: string | null = null): Promise<boolean> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0))`;
      // A replay takes the call's own lock next (the one order: the job's cutoff lock, then the call's), BEFORE it looks at anything: the key, the cutoff and the room are all read after that wait
      if (replayOf !== null) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${admitLockKey(jobId, callId)}, 0))`;
      if (await hasPoolCutoff(tx, jobId)) return false;
      if (await hasFinishIntent(tx, jobId)) return false;
      // A job that carried on is not worked on until its own browser is back: while `prep_state` is set every call is refused, under the same lock the claim and the settle write through, so no call can ever run against
      // a browser that is still being restored or one whose sign-ins could not be proved to be the job's own (GPT round 6, finding 7)
      const prep = await tx.computerJob.findUnique({ where: { id: jobId }, select: { prepState: true } });
      if (prep?.prepState !== null) return false;
      // The key is looked at with the time read AFTER whatever this call waited for (a lock, the pool), inside the lock a stop revokes the keys under
      const after = await verifyJobToken(token, 'model', clock(), tx);
      if (!after.ok || after.generation !== generation) return false;
      // Asked again for a call whose room an earlier request took (`replayOf` is the person who holds it): that request may still be deciding whether the call stands, and would give the room back. The room is looked at HERE,
      // under the call's own lock (taken above, after the job's cutoff lock), with the time read after the waits, BEFORE anything is written: a replay whose room is gone (given back, settled, lapsed) is refused and leaves
      // no admission, no stretch and no renewal of the hold behind. Its answer is kept under that lock, so the room is never released from under a call that was authorized (CodeRabbit on #1025)
      // The room is looked at under the POOL's lock as well (the lock every release and settlement of a room takes first), for a new room and a replayed one alike: a release that committed between the room being held and
      // this look is seen (the call is refused and leaves no admission), and one that comes after waits for this commit and finds the call admitted (CodeRabbit on #1025). The order is always: the job's cutoff lock, the call's
      // own lock, the pool's lock
      await lockPool(tx);
      if (!(await holdsItsRoom(jobId, callId, replayOf ?? holder, clock(), tx))) return false;
      // The call is ADMITTED: kept per call (one row), in this very transaction, for the first request and every replay alike. A room that lapses with no such row belongs to a call that was never admitted and is released, never
      // settled as unknown usage (the sweep reads it with `hasCallAdmission`), and a room whose creator could not give it back is kept for any request that was answered with it (CodeRabbit on #1025)
      await recordCallAdmission(tx, jobId, callId, clock());
      await recordTurnAdmitted(tx, jobId, { turn: admitted.turn, run: admitted.run, at: clock() });
      // The call belongs to the stretch it is admitted in: written HERE, under the lock a pause takes, so the order of an admission and a pause is exact (never two clocks), and the first admission decides (an
      // answer given again keeps it). A give-back after a pause reads it (lib/computer-stretch)
      await tx.$executeRaw`UPDATE "meter_reservations" SET "job_stretch" = (SELECT "pauses" FROM "computer_jobs" WHERE "id" = ${jobId}) WHERE "reservation_key" = ${callRoomKey(jobId, callId)} AND "job_stretch" IS NULL`;
      // A call admitted on the owner's own key is a beat: the owner is plainly there, so its hold on the job stands another 90 s and nobody else may claim it while it works (GPT round 6, finding 3)
      await extendHoldIn(tx, jobId, leaseUntil(clock()));
      return true;
    },
    { timeout: 15_000, maxWait: 15_000 },
  );
}

/**
 * The sweep's look at a lapsed call room: released only when its call was never admitted, decided and released as ONE step under the locks an admission writes under (the call's own lock, then the pool's, the order a replay
 * takes them in), so a replay or a first admission that commits meanwhile is seen (`admitted`: the room stays, to be settled as the usage it is) and never loses its room from under it. A look that fails is `unknown`: the room
 * is left for the next sweep, never read as admitted (it would be booked as usage the person is charged for) and never released (CodeRabbit on #1025).
 */
export async function releaseUnadmittedCallRoom(jobId: string, callId: string, key: string, now: Date): Promise<'released' | 'admitted' | 'unknown'> {
  try {
    return await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${admitLockKey(jobId, callId)}, 0))`;
        await lockPool(tx);
        if (await hasCallAdmission(tx, jobId, callId)) return 'admitted' as const;
        await releaseRoomIn(tx, { key }, now);
        return 'released' as const;
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
  } catch (error) {
    console.error('[Computer] Could not look at a lapsed call’s admission:', error instanceof Error ? error.message : 'unknown');
    return 'unknown';
  }
}

/** True when this call id already holds room for this job and person: room held and not lapsed (what reserving it again would answer with its own reservation). */
async function holdsItsRoom(jobId: string, callId: string, personId: string, now: Date, db: Pick<Prisma.TransactionClient, 'meterReservation'> = prisma): Promise<boolean> {
  const held = await db.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, callId) }, select: { state: true, personKey: true, jobId: true, expiresAt: true } });
  return !!held && held.state === 'held' && held.expiresAt > now && held.jobId === jobId && held.personKey === `person:${personId}`;
}

/**
 * Ends the job a call was refused for (computer.ts owns how a job ends; it is loaded when asked, as it reads this file). A refusal is answered whatever this does: never throws; says whether the job was ended (or paused).
 * The person's month or a limit they set PAUSES the job instead (piece 3, lib/computer-limit-pause), decided under the same conditions an ending was: the call's own key still good and the owner's, no kept intent, no
 * cutoff (while the person holds the screen too: it is taken back, section 7). It never ends the job for them. Our own pool's cutoff ends it as before, always.
 */
async function endForRefusal(jobId: string, why: { reason: 'allowance' } | { reason: 'rule' | 'pool'; words: string }, now: Date, from?: { epoch: number; tokenId: string }, blocked?: { kind: 'call'; micros: number }): Promise<boolean> {
  try {
    if (why.reason !== 'pool') {
      const { pauseForLimit } = await import('@/lib/computer-limit-pause');
      // What was refused goes with the pause (finding 5): it carries on by itself only once that call fits as well as the room to run
      return (await pauseForLimit(jobId, why.reason, now, from, blocked)) === 'paused';
    }
    const { stopJobForRefusal } = await import('@/lib/computer');
    await stopJobForRefusal(jobId, why, now, from);
    return true;
  } catch (error) {
    console.error('[Computer] Could not end a job whose model call was refused:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

export interface CallFacts {
  /** Millionths of a dollar the call cost; null when no price is known. */
  costMicros: number | null;
  /** How the figure was worked out: the bot server's own price list says. */
  basis: 'measured' | 'estimated' | 'unknown';
  /** Who paid: the platform, or the owner of the key the call ran on. */
  payer: { kind: 'universe' } | { kind: 'person'; personId: string };
  route: 'universe-ai' | 'own-key' | 'provider';
  tokens?: { input?: number | null; output?: number | null; cached?: number | null; reasoning?: number | null };
  /** The call ended before it finished (the person took over, the job stopped, the provider failed). Its cost is still counted. */
  cutShort?: boolean;
}

/**
 * A job that failed on our side (see `givenBackJob`) takes nothing from the person's month, and that includes the model calls it made:
 * they ran and the provider bills them, so each stays in the books as our own cost (the pool and the envelope still count it), but is
 * written against nobody, like the job's minutes. Calls on the owner's own key cost the platform nothing and are not touched.
 * Safe to say twice (a call already given back no longer matches), and for a job that ran fine or that the person stopped it is never called.
 */
export async function giveBackModelCalls(jobId: string, personId: string, now: Date = new Date()): Promise<void> {
  // The job's own computer time too: an end that wrote it against the person before the give-back was decided (a write that overlapped the decision, which then had no event to
  // detach) is written against nobody here, so a given-back job never keeps a charge on the person for its time
  await prisma.$executeRaw(Prisma.sql`
    UPDATE meter_events
    SET "person_key" = 'unknown', "person_id" = NULL,
        "detail" = COALESCE("detail", '{}'::jsonb) || jsonb_build_object('givenBack', true, 'forPersonId', ${personId}::text)
    WHERE "event_id" = ${`computer:${jobId}:time`} AND "person_key" = ${`person:${personId}`}`);
  // Only the calls of the job's last stretch: a job that was paused and carried on keeps every earlier stretch charged, with its calls (lib/computer-stretch)
  await prisma.$executeRaw(Prisma.sql`
    UPDATE meter_events e
    SET "person_key" = 'unknown', "person_id" = NULL,
        "detail" = COALESCE(e."detail", '{}'::jsonb) || jsonb_build_object('givenBack', true, 'forPersonId', ${personId}::text)
    FROM "computer_jobs" j
    WHERE j."id" = ${jobId} AND e."job_id" = j."id" AND e."kind" = 'model_call' AND e."pool" = 'computer' AND e."payer_kind" = 'universe' AND e."person_key" = ${`person:${personId}`}
      AND ${CALL_IN_LAST_STRETCH}`);
  // What the job drew from credit given for computers goes back into the lots it came from (each draw once: asked again it gives nothing more)
  await giveBackComputerCredit(jobId, now);
}

/** The figures of a finished call go to the books once, and its room is settled. Safe to say twice. Not for a call nobody authorized. */
export async function settleModelCall(jobId: string, callId: string, facts: CallFacts, now: Date = new Date()): Promise<{ ok: true } | { ok: false; reason: 'unknown_call' }> {
  if (!CALL_ID.test(callId)) return { ok: false, reason: 'unknown_call' };
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, botId: true, personId: true, status: true, endedBy: true } });
  if (!job) return { ok: false, reason: 'unknown_call' };
  const reservation = await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(job.id, callId) } });
  // A call on the owner's own key took no room, so there is none to find: it is still recorded. Anything else with no room was never authorized
  if (!reservation && facts.payer.kind === 'universe') return { ok: false, reason: 'unknown_call' };
  const cost = facts.costMicros === null ? null : Math.max(0, Math.min(MAX_MICROS, Math.round(facts.costMicros)));
  const paidByOther = facts.payer.kind === 'person';
  const eventId = `computer:${job.id}:call:${callId}`;
  // A call can cost more than the room held for it (the room is an upper reading made before the call; the price is known after). It cannot be
  // taken back, so it is written as it was, said as an overrun beside the figure, and counted from then on: it comes off the person's allowance
  // and the pool's room at once, so the next call is held against it (audit F9)
  const overrun = reservation && !paidByOther && cost !== null && cost > Number(reservation.amountMicros) ? cost - Number(reservation.amountMicros) : 0;
  if (overrun > 0) console.warn(`[Computer] A model call cost ${overrun} millionths of a dollar more than the room held for it`);
  // A call that reports after its job failed on our side is written against nobody from the start (a call on the owner's own key is not the person's to give back)
  // ...and only a call of the job's last stretch: one authorized before the job was paused stays the person's, whenever it reports
  const givenBack = !paidByOther && givenBackJob(job.status, job.endedBy) && (await callInLastStretch(job.id, callId));
  const givenBackDetail = givenBack ? { givenBack: true, forPersonId: job.personId } : {};
  const reportedDetail = { ...(facts.tokens ? { tokens: facts.tokens } : {}), ...(facts.cutShort ? { cutShort: true } : {}), ...(overrun > 0 ? { overrunMicros: overrun } : {}), ...givenBackDetail };
  // Credit given on purpose (a gift for computers) is drawn first, before the event is written, so the allowance never counts what credit paid:
  // asked twice it is the same draw. A call on the owner's own key, with no price known, or on a job that failed on our side draws nothing
  if (!givenBack && !paidByOther && cost !== null && cost > 0) await drawComputerCredit({ eventId, personId: job.personId, botId: job.botId, jobId: job.id, costMicros: cost, chargeClass: 'computer_model' }, now);
  const written = await recordMeterEvent({
    eventId,
    kind: 'model_call',
    pool: 'computer',
    occurredAt: now,
    personKey: givenBack ? 'unknown' : `person:${job.personId}`,
    personId: givenBack ? null : job.personId,
    botId: job.botId,
    brick: true,
    payerKind: paidByOther ? 'person' : 'universe',
    payerPersonId: facts.payer.kind === 'person' ? facts.payer.personId : null,
    route: facts.route,
    jobId: job.id,
    quantity: 1,
    unit: 'call',
    costMicros: cost,
    basis: paidByOther ? 'paid_by_other' : cost === null ? 'unknown' : facts.basis,
    sourceRef: `computer_jobs:${job.id}`,
    detail: reportedDetail,
  });
  // The sweep writes a call that never reported as unknown. A report that comes after it carries the real figure, which replaces the
  // unknown one (only an unknown figure is ever replaced: a figure that was written stays as it was)
  if (!written.recorded && cost !== null) {
    // The detail is merged into what is stored, never replaced: a give-back that happened in the meantime (the job failed after this report
    // read it as running) is kept. Only what this report says (its tokens, whether it was cut short and any overrun) is taken from the old detail first.
    const reported = JSON.stringify(reportedDetail);
    await prisma.$executeRaw(Prisma.sql`
      UPDATE meter_events
      SET "cost_micros" = ${BigInt(cost)}, "basis" = ${paidByOther ? 'paid_by_other' : facts.basis}, "route" = ${facts.route},
          "detail" = (COALESCE("detail", '{}'::jsonb) - 'tokens' - 'cutShort' - 'overrunMicros') || ${reported}::jsonb
      WHERE "event_id" = ${eventId} AND "cost_micros" IS NULL`);
  }
  // The job may have failed while this call was being written: its calls are given back when it ends, and this one was written after that
  // looked. Look again (the answer is only ever "failed on our side" once, so this is cheap and settles the race either way)
  if (!givenBack && !paidByOther) {
    const now2 = await prisma.computerJob.findUnique({ where: { id: job.id }, select: { status: true, endedBy: true } });
    if (now2 && givenBackJob(now2.status, now2.endedBy)) await giveBackModelCalls(job.id, job.personId, now);
  }
  // The room settles at what the books hold for this call, never at what this report says: a report sent again after a first one that wrote
  // the event but did not settle (or with another figure) must settle at the event's own cost. A price that is not known settles at the
  // room that was held (never 0); one that is settles at what it was, at least 1
  if (reservation) {
    const stored = await prisma.meterEvent.findUnique({ where: { eventId }, select: { costMicros: true } });
    const booked = stored ? (stored.costMicros === null ? null : Number(stored.costMicros)) : cost;
    await settleRoom({ key: reservation.reservationKey, settledMicros: Math.max(1, booked ?? Number(reservation.amountMicros)) }, now);
  }
  return { ok: true };
}

/** The call was never sent: its room is given back. Safe to say twice. */
export async function releaseModelCall(jobId: string, callId: string, now: Date = new Date()): Promise<void> {
  if (!CALL_ID.test(callId)) return;
  await releaseRoom({ key: callRoomKey(jobId, callId) }, now);
}
