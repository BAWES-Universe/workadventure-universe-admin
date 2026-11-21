import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { recordMeterEvent } from '@/lib/meter';
import { releaseRoom, reserveRoom, settleRoom } from '@/lib/meter-allowance';
import { revokeJobTokens, verifyJobToken } from '@/lib/computer-token';
import { givenBackJob } from '@/lib/computer-values';
import { drawComputerCredit, giveBackComputerCredit } from '@/lib/computer-credit';
import { routeIsPaused } from '@/lib/computer-route-pause';
import { POOL_BUSY_WORDS } from '@/lib/task-receipt-words';
import { hasOwnKeyCall, hasPoolRefusals, recordOwnKeyCall, recordPoolRefusal, retirePoolRefusals } from '@/lib/computer-faults';

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
  /** Our pool, or the controls, have no room: nothing the person can ask for. `full` is true when the pool has no room even for the smallest call (the envelope is at its ceiling) or when new work on the call's route is paused (our decision), so the relay can tell ours from a call refused for its own size. */
  | { ok: false; reason: 'pool'; full: boolean }
  /** A rule the person said in chat does not let this call take that much: the rule's own words, and nothing to ask more credit for. */
  | { ok: false; reason: 'rule'; ruleId: string; why: 'own_accounts' | 'cap'; leftMicros: number | null; words: string };

export async function authorizeModelCall(
  input: { token: string; callId: string; estimateMicros: number; payer: 'universe' | 'own-key'; /** The provider and route the call goes to, when the relay names it: new platform-funded work on a route that is failing for many people waits. */ route?: string | null },
  now: Date = new Date(),
): Promise<Authorized> {
  if (!CALL_ID.test(input.callId)) return { ok: false, reason: 'refused' };
  const verified = await verifyJobToken(input.token, 'model', now);
  if (!verified.ok) return { ok: false, reason: 'refused' };
  const base = { jobId: verified.jobId, botId: verified.botId, personId: verified.personId };
  if (input.payer === 'own-key') {
    // No room is taken, but a call after the fence is refused all the same
    const still = await verifyJobToken(input.token, 'model', now);
    if (!still.ok || still.generation !== verified.generation) return { ok: false, reason: 'refused' };
    // A call on the person's own key leaves no room and no price: Orbit keeps one marker per job that one was authorized, so "authorized, its report not here yet" is never read as "no call at all" (which is ours, and
    // an own key is never given back as ours). Never limits the call: the answer is the same whatever this does
    await recordOwnKeyCall(prisma, base.jobId, now).catch((error) => console.error('[Computer] Could not note an own-key call:', error instanceof Error ? error.message : 'unknown'));
    // A cutoff for our own capacity that was deciding at the same moment either saw this call (and did not stop the job) or won (and this call is refused): never both
    if (!(await authorizedPastCutoff(base.jobId, input.token, verified.generation, now))) return { ok: false, reason: 'refused' };
    return { ok: true, ...base, reservedMicros: null };
  }
  if (!Number.isSafeInteger(input.estimateMicros) || input.estimateMicros <= 0 || input.estimateMicros > MAX_MICROS) return { ok: false, reason: 'refused' };
  // One provider failing for many people: nothing new is sent to it for now (nothing is held or charged). Never for a person's own key. A pause is OUR decision,
  // so it answers `full: true`: the relay records it as a confirmed fault of ours (pool_busy), never as the job's own doing
  // The pause gates only NEW call ids: a call that already holds its room (the same job, the same person, still held) is asked again by a retry, and is answered
  // with its own authorization whatever the route's state is now: it was authorized before the pause, and refusing its retry would make the relay record a fault of ours for a call that is going on
  if (input.route && !(await holdsItsRoom(base.jobId, input.callId, base.personId, now)) && (await routeIsPaused(input.route, now).catch(() => false))) {
    await refusedForPool(base.jobId, input.callId, input.route, now);
    return { ok: false, reason: 'pool', full: true };
  }
  const room = await reserveRoom({ key: callRoomKey(base.jobId, input.callId), personId: base.personId, amountMicros: input.estimateMicros, botId: base.botId, jobId: base.jobId, newJob: false }, now);
  if (room.ok) {
    // The room may have waited for the pool's lock while the person took the machine: the key must still be good after it, or the room goes back
    const still = await verifyJobToken(input.token, 'model', now);
    if (!still.ok || still.generation !== verified.generation) {
      await releaseRoom({ key: callRoomKey(base.jobId, input.callId) }, now);
      return { ok: false, reason: 'refused' };
    }
    // A cutoff for our own capacity that was deciding at the same moment either counted this room (and did not stop the job) or won (the key is no longer good): the room goes back, never both
    if (!(await authorizedPastCutoff(base.jobId, input.token, verified.generation, now))) {
      await releaseRoom({ key: callRoomKey(base.jobId, input.callId) }, now);
      return { ok: false, reason: 'refused' };
    }
    // Capacity is back: what was refused before it stops deciding the turns that come after
    await retirePoolRefusals(prisma, base.jobId).catch((error) => console.error('[Computer] Could not retire a recovered pool refusal:', error instanceof Error ? error.message : 'unknown'));
    return { ok: true, ...base, reservedMicros: room.reservation.amountMicros };
  }
  // A call refused for the person's own allowance or a rule they said ends the job right here, as a refused renewal does (stopped, by `allowance` or `rule`,
  // which is theirs): the agent's turns that fail on the refusal can then never end the job as ours and give back everything it ran before the limit
  if (room.reason === 'allowance') {
    await endForRefusal(base.jobId, { reason: 'allowance' }, now);
    return { ok: false, reason: 'allowance' };
  }
  if (room.reason === 'rule') {
    await endForRefusal(base.jobId, { reason: 'rule', words: room.words }, now);
    return { ok: false, reason: 'rule', ruleId: room.ruleId, why: room.why, leftMicros: room.leftMicros, words: room.words };
  }
  // Asked again for a call whose room was settled or lapsed: the first try is the call, and a second one is not another
  if (room.reason === 'closed' || room.reason === 'key_reused') return { ok: false, reason: 'refused' };
  // A call refused for its own SIZE (the room left is smaller than what it asked, `full: false`) says nothing about our capacity: only a pool with no room even for the smallest call is ours
  if (!(room.reason === 'pool' && room.full !== true)) await refusedForPool(base.jobId, input.callId, input.route ?? null, now);
  return { ok: false, reason: 'pool', full: room.reason === 'pool' && room.full === true };
}

/** How many calls of a job that has never had one authorized may be refused for our own capacity before the job is stopped as ours: its first turn (and one retry of it) found no room. */
export const POOL_REFUSALS_BEFORE_STOP = 2;

/**
 * A model call was refused for OUR capacity (the pool has no room, or its route is paused). For a job whose calls have ALL been refused so far (not one authorized, in any state) that is a confirmed fault of ours, kept by
 * Orbit itself (one row per call, so a retried call counts once) whatever the relay writes about it. Such a job that has now had `POOL_REFUSALS_BEFORE_STOP` refused is not going anywhere: every call it makes
 * is refused, and left alone it would spin on its person's allowance of time. It is stopped as `pool` (ours: its time given back, never counted, with the words the person is told). A job that had a
 * call authorized before is never stopped here: a refusal in the middle of its work is the relay's to tell, and the job's own renewal ends it if the pool stays full. Never throws: a refusal is answered whatever this does.
 */
async function refusedForPool(jobId: string, callId: string, route: string | null, now: Date): Promise<void> {
  let cutoff = false;
  try {
    // One lock per job, held from the count to the moment the job's keys end, and DATABASE STEPS ONLY: no provider call and no other transaction is made while it is held (the end of the job is slow: it
    // cancels the agent's turn, hands files over, rests the machine). An authorization that is deciding at the same moment waits for it (`authorizedPastCutoff`), so the job is never stopped for a count of
    // zero authorized calls that a call authorized meanwhile made wrong, and a call authorized after the decision is refused
    cutoff = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0))`;
        // Only a job whose calls have ALL been refused so far: one that had a call authorized before (a room held or priced, or one on the person's own key, which leaves only its marker) is left to the relay's own words
        const authorized = await tx.meterReservation.count({ where: { jobId, reservationKey: { startsWith: callRoomKey(jobId, '') } } });
        const priced = authorized > 0 ? 0 : await tx.meterEvent.count({ where: { jobId, kind: 'model_call' } });
        if (authorized > 0 || priced > 0 || (await hasOwnKeyCall(tx, jobId))) return false;
        const refused = await recordPoolRefusal(tx, jobId, callId, { route, at: now });
        if (refused < POOL_REFUSALS_BEFORE_STOP) return false;
        // The decision is made durable here, under the lock: every key of the job ends, so a call authorized after this commit finds its key dead and is refused. Ending the job itself comes after
        await revokeJobTokens(jobId, now, undefined, tx);
        return true;
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
  } catch (error) {
    console.error('[Computer] Could not note a model call refused for our capacity:', error instanceof Error ? error.message : 'unknown');
    return;
  }
  // The slow end of the job, with no lock and no transaction held. Its keys already ended; the job is ended as ours (given back, never counted). Never throws
  if (cutoff) await endForRefusal(jobId, { reason: 'pool', words: POOL_BUSY_WORDS }, now);
}

/** The lock a cutoff for our own capacity and an authorization that may be deciding at the same moment take one after the other (exported for the tests). */
export const cutoffLockKey = (jobId: string): string => `computer-call-cutoff:${jobId}`;

/**
 * Whether a call that was just authorized (its room held, or its marker kept) stands against a cutoff for our own capacity that may be deciding at the same moment. A job with no refusal of ours kept has none
 * (the common case: one count, nothing waited for). Otherwise this waits for the job's cutoff lock, which the cutoff holds only while it counts and ends the job's keys (database steps, no provider call), and
 * then asks again whether the key is still good: a cutoff that counted this call ended no key, and one that won ended them, so the call is refused and its room goes back.
 */
async function authorizedPastCutoff(jobId: string, token: string, generation: number, now: Date): Promise<boolean> {
  if (!(await hasPoolRefusals(prisma, jobId))) return true;
  try {
    await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${cutoffLockKey(jobId)}, 0))`;
      },
      { timeout: 15_000, maxWait: 15_000 },
    );
  } catch (error) {
    // The wait failed (no connection, or a lock held too long): the key is still the guard, asked next, and a key that is good is the call's
    console.error('[Computer] Could not wait for a cutoff that was deciding:', error instanceof Error ? error.message : 'unknown');
  }
  const after = await verifyJobToken(token, 'model', now);
  return after.ok && after.generation === generation;
}

/** True when this call id already holds room for this job and person: room held and not lapsed (what reserving it again would answer with its own reservation). */
async function holdsItsRoom(jobId: string, callId: string, personId: string, now: Date): Promise<boolean> {
  const held = await prisma.meterReservation.findUnique({ where: { reservationKey: callRoomKey(jobId, callId) }, select: { state: true, personKey: true, jobId: true, expiresAt: true } });
  return !!held && held.state === 'held' && held.expiresAt > now && held.jobId === jobId && held.personKey === `person:${personId}`;
}

/** Ends the job a call was refused for (computer.ts owns how a job ends; it is loaded when asked, as it reads this file). A refusal is answered whatever this does. */
async function endForRefusal(jobId: string, why: { reason: 'allowance' } | { reason: 'rule' | 'pool'; words: string }, now: Date): Promise<void> {
  try {
    const { stopJobForRefusal } = await import('@/lib/computer');
    await stopJobForRefusal(jobId, why, now);
  } catch (error) {
    console.error('[Computer] Could not end a job whose model call was refused:', error instanceof Error ? error.message : 'unknown');
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
  await prisma.$executeRaw(Prisma.sql`
    UPDATE meter_events
    SET "person_key" = 'unknown', "person_id" = NULL,
        "detail" = COALESCE("detail", '{}'::jsonb) || jsonb_build_object('givenBack', true, 'forPersonId', ${personId}::text)
    WHERE "job_id" = ${jobId} AND "kind" = 'model_call' AND "pool" = 'computer' AND "payer_kind" = 'universe' AND "person_key" = ${`person:${personId}`}`);
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
  const givenBack = !paidByOther && givenBackJob(job.status, job.endedBy);
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
