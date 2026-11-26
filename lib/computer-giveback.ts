import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';
import { ALERT_TRANSACTION_OPTIONS, tellSentry } from '@/lib/computer-alerts';
import { prisma } from '@/lib/db';
import { getInstantLimitsStrict } from '@/lib/instant/state';
import { INSTANT_LIMITS_RECOMMENDED, type InstantLimits } from '@/lib/instant/values';
import { monthOf } from '@/lib/meter-values';
import { callRoomKey, giveBackModelCalls } from '@/lib/computer-calls';
import { OURS_REASONS, RELAY_REACHED, lockRelayReach, RELAY_UNREACHABLE, isInferredUnreachableRow, isRunnerNoRelayRow, readFaultRows, recordRelayUnreachable, relayReachedInRun, rowsOfRun, type FaultRow } from '@/lib/computer-faults';
import { incidentFaultMatch } from '@/lib/computer-route-pause';
import { retryWaitMs } from '@/lib/computer-retry';

/**
 * Whether a computer job that failed is given back, and the kept record of why (table computer_give_back_decisions).
 *
 * A job's words are the person's, so a brief can make the agent do the work and then crash its own machine, and that looks like a failure of ours. Money
 * therefore depends on what the failure was, judged by Orbit from the relay's durable rows (lib/computer-faults) when the computer's runner reports a
 * failure with cause "ours" (its cause is only a hint: a failure it calls the agent's own, or says nothing about, but names turns for is read against the same rows, and a
 * confirmed fault of ours in them is given back too, whichever arrives first, the rows or the finish: `decideHintedFinish`, `afterLateEvidence`). Three classes:
 *
 *  1. A fault only OURS can cause (relay side, or the provider refusing our key): ALWAYS given back, never counted. If any bad turn of the failed streak
 *     was one, the ending is ours, whatever else happened in it.
 *  2. A fault the PERSON caused, with evidence (their allowance, a rule, their own key, a field their job set): charged like any run.
 *  3. UNRESOLVED (a crash with nothing noted, a provider 5xx or 429, a timeout, a 400 with no field): bounded goodwill, decided as follows.
 *     - A job that settled something outside its computer as done delivered: no GOODWILL is given back (an incident that operations establishes caused it, or a confirmed fault of ours, still gives its computer cost back; the App's own charge stays on its own line).
 *     - A job with an outside effect still to be confirmed is held (`pending`) until it is, or until the bounded close (Instant's wait for an unreachable
 *       log): done means none, failed means give back. The same rule as Instant: a late confirmation never takes a give-back back.
 *     - A person has a bounded number of give-backs a month (UTC): Instant's "Give-backs one person may have in a month" when a super admin set it,
 *       otherwise what Instant's pause rule tolerates in its smallest batch (pauseMinRuns x pauseFailureRateBps: 2 on the launch numbers). Only these count.
 *     - Instant's pause rule on the person's own month pauses repeated ones (redundant at launch: the bound stops first).
 *     Settings that are missing or could not be read are never a final charge and never "no bound": the decision is `pending`, the person is charged
 *     provisionally, and the sweep decides it again with a growing wait; a decision that turns out `given` gives back everything the job took.
 *
 * Endings Orbit saw itself (a lapsed room, a closed room, a machine that would not start) are always given back and never counted, and are recorded too.
 * Calls on a person's own key and Universe AI chat, direct messages and voice never come through here.
 */

export type GiveBackLimits = Pick<InstantLimits, 'goodwillPerPersonPerMonth' | 'pauseMinRuns' | 'pauseFailureRateBps' | 'unreachableWaitMinutes' | 'unclearWaitMinutes'>;

export type Verdict =
  | { state: 'given'; basis: 'universe_fault' | 'goodwill' | 'orbit_fault' | 'incident'; counted: boolean; reason: string | null; route: string | null; /** The turns the verdict was read from, when the runner named none and Orbit chose the last one with a row. */ judgedTurns?: number[] }
  | { state: 'refused'; basis: 'person_caused' | 'delivered' | 'cap' | 'paused' | 'agent_ended'; reason: string | null; route: string | null; judgedTurns?: number[] }
  | { state: 'pending'; basis: 'effect_unresolved' | 'limits_unreadable' | 'limits_missing'; reason: string | null; route: string | null; judgedTurns?: number[] };

/** What the runner said the cause of a failed finish was. Only a hint: the rows decide. */
export type FinishHint = 'ours' | 'agent' | 'none';

/** The hint a decision was made under (a decision kept before hints were all kept has only `ours`). */
export const hintOf = (kept: string | null | undefined): FinishHint => (kept === 'agent' || kept === 'none' ? kept : 'ours');

const MINUTE = 60 * 1000;

/** The most give-backs one person may have in a month, or null when Limits carry no number to read one from. */
export function personGiveBackBound(limits: Pick<InstantLimits, 'goodwillPerPersonPerMonth' | 'pauseMinRuns' | 'pauseFailureRateBps'>): number | null {
  if (limits.goodwillPerPersonPerMonth !== null && limits.goodwillPerPersonPerMonth >= 1) return limits.goodwillPerPersonPerMonth;
  if (limits.pauseMinRuns === null || limits.pauseFailureRateBps === null) return null;
  return Math.max(1, Math.floor((limits.pauseMinRuns * limits.pauseFailureRateBps) / 10_000));
}

/** Instant's pause rule on one person's own month: enough jobs ended, and the share given back reached the share that pauses Instant. */
export function personGiveBackPaused(limits: Pick<InstantLimits, 'pauseMinRuns' | 'pauseFailureRateBps'>, ended: number, given: number): boolean {
  if (limits.pauseMinRuns === null || limits.pauseFailureRateBps === null) return false;
  if (ended < limits.pauseMinRuns) return false;
  return Math.floor((given * 10_000) / ended) >= limits.pauseFailureRateBps;
}

/** What is wrong with the settings the bound reads, in words for an operator; empty when it can be read. */
export function giveBackSettingsProblems(limits: Pick<InstantLimits, 'goodwillPerPersonPerMonth' | 'pauseMinRuns' | 'pauseFailureRateBps'>): string[] {
  const out: string[] = [];
  if (personGiveBackBound(limits) === null) out.push('No bound on give-backs can be read: Instant’s pause numbers are empty, so computer give-backs for unresolved failures wait (the person is charged provisionally) until they are set.');
  // Two different settings, said apart: how many people a provider failing for pauses new platform-funded work (the number of runs), and the share of one person's
  // jobs given back that pauses further give-backs for that person (the failure rate)
  if (limits.pauseMinRuns === null) out.push('Instant’s pause number of runs is not set, so a provider failing for many people cannot pause new platform-funded computer work.');
  if (limits.pauseFailureRateBps === null) out.push('Instant’s pause failure rate is not set, so a person’s own run of give-backs is not paused by its share.');
  return out;
}

/** Limits for a decision, read twice at most; null when they could not be read, which is never the same as none being set. Read before any transaction opens. */
export async function readGiveBackLimits(): Promise<GiveBackLimits | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await getInstantLimitsStrict();
    } catch (error) {
      console.error('[Computer] Could not read the limits for the bound on give-backs:', error instanceof Error ? error.message : 'unknown');
    }
  }
  return null;
}

export { retryWaitMs };

interface JobRef {
  id: string;
  personId: string;
  startedAt: Date | null;
  /** When the job ended, as stored (absent at its own finish: it ends now). The goodwill count is of THAT month, whenever the decision is made. */
  endedAt?: Date | null;
}

/** The last turn of a run (no run: the turns of no run) that has a row saying something went wrong, or null: where a failure the runner named no turns for is looked for. */
export async function lastFaultTurn(db: Pick<Prisma.TransactionClient, 'computerJobFault'>, jobId: string, run: string | null | undefined): Promise<number | null> {
  const last = await db.computerJobFault.findFirst({ where: { jobId, run: run ?? null, turn: { not: null }, kind: { not: 'answered' } }, orderBy: { turn: 'desc' }, select: { turn: true } });
  return last?.turn ?? null;
}

/**
 * True when a job's computer was readied for a model (a model key was made: prepare passed) and Orbit holds no trace at all of a model call for it: no fault row of any kind (answered ones too, which
 * includes the marker that a call on the person's own key was authorized: such a call takes no room and prices nothing), no model call priced and no room held for one. Such a job never reached the
 * relay, whoever's key the calls would have run on. A job whose control ever changed hands is never judged so: the person taking the machine (or giving it back) ends the agent's keys, a call after
 * that is refused and leaves no row, so the absence of a call says nothing about the relay. What Orbit keeps of it is the job's control generation (every change of control moves it up, `fenceControl`)
 * and who holds control now. A run the relay itself says it reached (an arrival row of that run: `relayReachedInRun`) never did not reach it, whatever else is or is not held: that is the first rule here, not a
 * consequence of the count. The rows counted are the run's own (and those that name no run); another run's say nothing of this one. Reads only.
 */
export async function neverReachedRelay(db: Pick<Prisma.TransactionClient, 'computerJob' | 'computerJobToken' | 'computerJobFault' | 'meterEvent' | 'meterReservation'>, jobId: string, run: string | null = null): Promise<boolean> {
  if ((await db.computerJobToken.count({ where: { jobId, scope: 'model' } })) === 0) return false;
  // THE RULE: the relay said it was reached by this run (an arrival row: it authenticated the run's key), so the run did reach it, whatever else Orbit holds or does not hold. Only the run's own word counts: another run's arrival says nothing of this one
  if (await relayReachedInRun(db, jobId, run)) return false;
  const job = await db.computerJob.findUnique({ where: { id: jobId }, select: { controlGeneration: true, control: true } });
  // A job that is not there, or whose control was ever the person's, is not judged by what it did not ask
  if (!job || job.controlGeneration > 0 || job.control !== 'brick') return false;
  const [faults, events, rooms] = await Promise.all([
    // The run's own rows (and the rows that name no run): another run's call, answered or not, is not a trace of this run's. Calls priced or held a room are the job's (they carry no run)
    // The arrival rows are not counted here: they are the rule above, and only the run's own (a row of another run is not read here at all)
    db.computerJobFault.count({ where: { jobId, ...rowsOfRun(run), NOT: { kind: 'answered', reason: RELAY_REACHED, source: 'universe-ai' } } }),
    db.meterEvent.count({ where: { jobId, kind: 'model_call' } }),
    db.meterReservation.count({ where: { jobId, reservationKey: { startsWith: callRoomKey(jobId, '') } } }),
  ]);
  return faults === 0 && events === 0 && rooms === 0;
}

/**
 * The row of ours a decision rests on, or undefined. That the computer could not reach the relay names the reason when other rows of ours (the relay's own `relay_down`, written for the same thing) say it too:
 * Orbit's own finding, or the runner's own marker of it (its prepare could not, or no call reached the relay: a `relay_down` row under a call id of its own), which is the same finding said by the runner.
 * The relay's own `relay_down` (a 503 it answered: the computer reached it) is under a real call's id and keeps its reason. The money, the basis and the count are those of any fault of ours; only the
 * reason (the words the person reads) and the route (no provider's) are this finding's. Used by the finish and by a row that arrives after it, so both say the same.
 */
function oursFinding(allRows: readonly FaultRow[], reached = false): FaultRow | undefined {
  // The row Orbit kept when it INFERRED, from the absence of every trace, that the relay was never reached is ignored once the relay says it was (an arrival row): it stays as a record, and never names the reason
  const rows = reached ? allRows.filter((row) => !isInferredUnreachableRow(row)) : allRows;
  const own = rows.find((row) => row.cls === 'ours' && row.reason === RELAY_UNREACHABLE);
  if (own) return own;
  const noRelay = rows.find((row) => row.cls === 'ours' && isRunnerNoRelayRow(row));
  return noRelay ? { ...noRelay, reason: RELAY_UNREACHABLE, route: null } : rows.find((row) => row.cls === 'ours');
}

/**
 * Decides one failed job the runner reported as ours. Runs inside a transaction, under the person's give-back lock, so two jobs of one person deciding
 * together cannot both take the last give-back. `limits` are read before the transaction opens (null: they could not be read).
 */
export async function decideRunnerFinish(
  tx: Prisma.TransactionClient,
  limits: GiveBackLimits | null,
  job: JobRef,
  turns: readonly number[] | null | undefined,
  now: Date,
  options: { effectsClosed?: boolean; run?: string | null; hint?: FinishHint } = {},
): Promise<Verdict> {
  // A failed finish is judged whatever the runner's hint (the hint is evidence, never the verdict). Hint `ours` reads the turns the runner named (every row when it named none) and a turn it
  // named that has no row is unresolved. Any other hint reads the turns it named too, or, when it named none, the LAST turn of its run that has a row; a turn with no row says nothing wrong
  // was recorded, so the agent ending on its own is the person's (`agent_ended`, never counted): no brief can make a job free without a recorded fault
  const lenient = options.hint !== undefined && options.hint !== 'ours';
  let judged: readonly number[] | null | undefined = turns;
  if (lenient && !(turns && turns.length > 0)) {
    const last = await lastFaultTurn(tx, job.id, options.run);
    judged = last === null ? [] : [last];
  }
  // A runner that named no turn, with no numbered row to choose one from, still has the rows that apply to the whole job (a fault of ours before any turn: the relay down, a key that could not be read):
  // those are read, and never an empty list of turns, which would read the numbered rows of every run
  const rows = await readFaultRows(tx, job.id, judged, options.run, { turnlessOnly: lenient && !!judged && judged.length === 0 });
  const judgedTurns = lenient && !(turns && turns.length > 0) ? [...(judged ?? [])] : undefined;
  // The relay's own word that this run reached it (an arrival row): Orbit's inference below is never made for it, and an inference made earlier names nothing
  const reached = await relayReachedInRun(tx, job.id, options.run);
  let ours = oursFinding(rows, reached);
  // Nothing was charged for a job that never started: there is nothing to hold back
  if (!job.startedAt) return { state: 'given', basis: 'universe_fault', counted: false, reason: ours?.reason ?? 'not_started', route: ours?.route ?? null, judgedTurns };
  // A job whose computer was readied to ask for a model, and for which Orbit holds not one trace of a call (no row of any kind, no call held room or was priced), never reached the relay: no brief makes a
  // model call fail before it is asked, so this is ours (the address, the relay, the network between), kept as the confirmed fault it is so every later reading of the job finds it
  // The arrival row's write takes the lock below too: the arrival and the trace are read as one, never with an arrival committing between the two reads
  if (!ours) await lockRelayReach(tx, job.id);
  if (!ours && (await neverReachedRelay(tx, job.id, options.run ?? null))) {
    await recordRelayUnreachable(tx, job.id, { run: options.run ?? null, at: now, inferred: true });
    ours = { turn: null, callId: RELAY_UNREACHABLE, kind: 'fault', reason: RELAY_UNREACHABLE, source: 'universe-ai', route: null, cls: 'ours' };
  }
  // Class 1: any bad turn of ours makes the ending ours
  if (ours) return { state: 'given', basis: 'universe_fault', counted: false, reason: ours.reason, route: ours.route, judgedTurns };
  const person = rows.find((row) => row.cls === 'person');
  // A turn the runner judged failed that has no row at all (a crash, a stream that broke) is unresolved, never the person's (hint `ours` only)
  const silent = !lenient && turns && turns.length > 0 ? turns.find((turn) => !rows.some((row) => row.turn === turn)) : undefined;
  const unresolved = rows.find((row) => row.cls === 'unresolved') ?? (silent !== undefined ? { reason: 'no_row', route: null } : undefined);
  // Class 2: evidence it was the person's, and nothing that points at us
  if (person && !unresolved) return { state: 'refused', basis: 'person_caused', reason: person.reason, route: person.route, judgedTurns };
  // The agent ended on its own with nothing wrong recorded on what was judged
  if (lenient && !unresolved) return { state: 'refused', basis: 'agent_ended', reason: null, route: null, judgedTurns };

  // Class 3: bounded goodwill
  const reason = unresolved?.reason ?? null;
  const route = unresolved?.route ?? null;
  // Both states are read in ONE statement, so a send that turns from planned to done between two reads can never be seen as neither: one done blocks goodwill, one still
  // planned (and none done) defers the decision
  const effects = await tx.computerEffect.groupBy({ by: ['state'], where: { jobId: job.id, state: { in: ['done', 'planned'] } }, _count: { _all: true } });
  if (effects.some((one) => one.state === 'done')) return { state: 'refused', basis: 'delivered', reason, route, judgedTurns };
  if (!options.effectsClosed && effects.some((one) => one.state === 'planned')) return { state: 'pending', basis: 'effect_unresolved', reason, route, judgedTurns };
  if (!limits) return { state: 'pending', basis: 'limits_unreadable', reason, route, judgedTurns };
  const bound = personGiveBackBound(limits);
  if (bound === null) return { state: 'pending', basis: 'limits_missing', reason, route, judgedTurns };

  // The month the job ended in, not the month the decision is made in: a job that ended on the 31st and is decided on the 1st uses the 31st's month, for both counts
  const month = monthOf(job.endedAt ?? now);
  const ran = { personId: job.personId, id: { not: job.id }, startedAt: { not: null }, endedAt: { gte: month.start, lt: month.end } };
  const [given, ended] = await Promise.all([
    // Only goodwill gives count: a fault of ours, an outage and an incident correction use none of a person's bound
    tx.computerJob.count({ where: { ...ran, status: { in: ['failed', 'stopped'] }, endedBy: 'error', runnerFault: true } }),
    // Jobs that ended after running, but not the ones the person ended themselves or turned off: those say nothing about how the work goes
    tx.computerJob.count({ where: { ...ran, status: { in: ['done', 'failed', 'stopped'] }, OR: [{ endedBy: null }, { endedBy: { notIn: ['person', 'off', 'deleted'] } }] } }),
  ]);
  if (given >= bound) return { state: 'refused', basis: 'cap', reason, route, judgedTurns };
  if (personGiveBackPaused(limits, ended, given)) return { state: 'refused', basis: 'paused', reason, route, judgedTurns };
  return { state: 'given', basis: 'goodwill', counted: true, reason, route, judgedTurns };
}

/** Takes the person's advisory lock for give-backs (held to the end of the transaction). */
export const lockPerson = (tx: Prisma.TransactionClient, personId: string) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`computer:giveback:${personId}`}))`;

/** Keeps the decision (one row per job). A decision that is still pending is tried again after a short wait. */
export async function writeDecision(
  tx: Prisma.TransactionClient,
  job: { id: string; personId: string },
  verdict: Verdict,
  hint: string | null,
  turns: readonly number[] | null | undefined,
  now: Date,
  run: string | null | undefined = null,
): Promise<void> {
  const data = {
    state: verdict.state,
    basis: verdict.basis,
    causeHint: hint,
    reason: verdict.reason,
    route: verdict.route,
    judgedTurns: [...(turns ?? [])],
    // The run the runner reported is ALWAYS kept: where the relay's arrival is looked for again (the reachability of that run, never another's). Which fault rows are read is a separate matter and does not
    // follow it: a finish that named no turns reads the rows of every run (readFaultRows with no turns takes no run), and only a hint other than ours or named turns look at one run's rows
    judgedRun: run ?? null,
    nextAttemptAt: verdict.state === 'pending' ? new Date(now.getTime() + retryWaitMs(0)) : null,
  };
  await tx.computerGiveBackDecision.upsert({ where: { jobId: job.id }, create: { jobId: job.id, personId: job.personId, ...data }, update: data });
}

/** An ending Orbit saw itself is always given back; it is recorded so support and the operations view see it with the rest. */
export async function writeOrbitDecision(tx: Prisma.TransactionClient, job: { id: string; personId: string }, reason: 'pool_cut_off' | null = null): Promise<void> {
  await tx.computerGiveBackDecision.upsert({
    where: { jobId: job.id },
    create: { jobId: job.id, personId: job.personId, state: 'given', basis: 'orbit_fault', causeHint: null, reason, route: null, judgedTurns: [] },
    update: {},
  });
}

/**
 * Turns a job that was charged (failed, no ending) into one that failed on our side, inside the caller's transaction: the job is marked, and its computer
 * time, if it was written against the person, is written against nobody. Safe to say twice. Returns whether the job changed. The model calls and the credit
 * the job drew follow (`giveBackAfter`), and the sweep finds them if that does not go through.
 */
export async function applyGiveBack(tx: Prisma.TransactionClient, job: { id: string; personId: string }, counted: boolean): Promise<boolean> {
  const changed = await tx.computerJob.updateMany({ where: { id: job.id, status: 'failed', endedBy: null }, data: { endedBy: 'error', runnerFault: counted } });
  await tx.$executeRaw`
    UPDATE meter_events
    SET "person_key" = 'unknown', "person_id" = NULL,
        "detail" = COALESCE("detail", '{}'::jsonb) || jsonb_build_object('givenBack', true, 'forPersonId', ${job.personId}::text)
    WHERE "event_id" = ${`computer:${job.id}:time`} AND "person_key" = ${`person:${job.personId}`}`;
  return changed.count > 0;
}

/** A counted goodwill give-back is freed from the person's bound (the job is no longer a counted one). Safe to say twice. */
export async function uncountGiveBack(tx: Prisma.TransactionClient, jobId: string): Promise<void> {
  await tx.computerJob.updateMany({ where: { id: jobId, runnerFault: true }, data: { runnerFault: false } });
}

/** An incident's correction of one decision: a goodwill give-back is re-labelled and freed from the bound (true), a held or cap/pause-refused one becomes a give-back (the caller gives it back). */
export async function correctDecisionForIncident(tx: Prisma.TransactionClient, job: { id: string; personId: string }, incident: { route: string; from: Date; to: Date }): Promise<'uncounted' | 'given' | null> {
  const route = incident.route;
  // Only the decision's OWN evidence corrects it, read again here under the person's lock: a fault of an earlier run of the same job, on the same route inside the window,
  // never reverses a decision judged on a later one (the candidate query asks the same, so this is the check on what the decision is at this moment)
  const proof = await tx.$queryRaw<Array<{ one: number }>>(Prisma.sql`
    SELECT 1 AS one FROM "computer_give_back_decisions" d JOIN "computer_job_faults" f ON f."job_id" = d."job_id"
    WHERE d."job_id" = ${job.id} AND ${incidentFaultMatch(route, incident.from, incident.to, OURS_REASONS)} LIMIT 1`);
  if (proof.length === 0) return null;
  const freed = await tx.computerGiveBackDecision.updateMany({ where: { jobId: job.id, state: 'given', basis: 'goodwill' }, data: { basis: 'incident', route } });
  if (freed.count > 0) {
    await uncountGiveBack(tx, job.id);
    return 'uncounted';
  }
  // Once operations has established that the incident caused this job's failure, the confirmed-fault rule applies even if another step of the job delivered: the computer's own cost
  // (its time, its model calls, the credit they drew) is given back, and what an App delivered and charged stays on its own line, untouched. Only a held, cap/pause-refused, delivered-refused
  // or runner-hint-refused decision turns; a decision the person's own evidence refused (person_caused) is left alone, and a give-back already made is never taken back
  const flipped = await tx.computerGiveBackDecision.updateMany({
    where: { jobId: job.id, OR: [{ state: 'pending' }, { state: 'refused', basis: { in: ['cap', 'paused', 'delivered', 'agent_ended'] } }] },
    data: { state: 'given', basis: 'incident', route, nextAttemptAt: null, lastError: null },
  });
  if (flipped.count === 0) return null;
  await applyGiveBack(tx, job, false);
  return 'given';
}

/** The calls and credit of a job that was given back. Never throws. */
export async function giveBackAfter(job: { id: string; personId: string }, now: Date = new Date()): Promise<void> {
  await giveBackModelCalls(job.id, job.personId, now).catch((error) => console.error('[Computer] Could not give back a job’s model calls:', error instanceof Error ? error.message : 'unknown'));
}

/**
 * Decides a `pending` decision again (limits now readable or set, an outside effect now confirmed or closed). A decision that is still not possible stays
 * pending with a longer wait; one that is `given` gives back everything the job took. Safe to say twice.
 */
export async function resolveDecision(jobId: string, now: Date = new Date(), options: { closing?: boolean } = {}): Promise<'resolved' | 'pending' | 'none'> {
  const decision = await prisma.computerGiveBackDecision.findUnique({ where: { jobId } });
  if (!decision || decision.state !== 'pending') return 'none';
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, personId: true, startedAt: true, endedAt: true } });
  if (!job) {
    // The job is gone (its Brick was purged) while the decision still waited: never a final charge. It is given back in the person's favour, uncounted; what the
    // job wrote is found by its id (the time event and the calls), and the credit by the refund obligations
    const gone = { id: jobId, personId: decision.personId };
    const closed = await prisma.$transaction(async (tx) => {
      await lockPerson(tx, gone.personId);
      // Read again under the lock: a decision made in the meantime (an incident correction) stands
      const current = await tx.computerGiveBackDecision.findUnique({ where: { jobId }, select: { state: true } });
      if (!current || current.state !== 'pending') return false;
      await tx.computerGiveBackDecision.update({ where: { jobId }, data: { state: 'given', basis: 'orbit_fault', reason: 'job_removed', nextAttemptAt: null, lastError: null, attempts: { increment: 1 } } });
      await applyGiveBack(tx, gone, false);
      return true;
    });
    if (!closed) return 'none';
    await giveBackAfter(gone, now);
    return 'resolved';
  }
  const limits = await readGiveBackLimits();
  const closeAfter = (limits?.unreachableWaitMinutes ?? INSTANT_LIMITS_RECOMMENDED.unreachableWaitMinutes) * MINUTE;
  // A purge closes the decision: the Brick's jobs and fault rows are about to go, so nothing more can ever be learned for it
  const effectsClosed = options.closing === true || now.getTime() - decision.decidedAt.getTime() >= closeAfter;
  const verdict = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, job.personId);
    // Read again under the person's lock: an incident correction (or another retry) may have decided it since the read above, and that decision stands. The WHOLE row is read here and
    // everything judged from it comes from this read: a retry that read before the lock would judge on an older `judgedTurns` and write it over the turn list another retry committed first
    // (CodeRabbit on #1032, 00abcd25 pass)
    const current = await tx.computerGiveBackDecision.findUnique({ where: { jobId } });
    if (!current || current.state !== 'pending') return null;
    let next = await decideRunnerFinish(tx, limits, job, current.judgedTurns, now, { effectsClosed, run: current.judgedRun, hint: hintOf(current.causeHint) });
    // Limits that cannot be read or are not set cannot be waited out when the evidence is about to be deleted: the person is not charged for it
    if (options.closing && next.state === 'pending') next = { state: 'given', basis: 'orbit_fault', counted: false, reason: 'brick_purged', route: next.route };
    // `judgedTurns` is the turn the finish was judged on when it was not stored before (undefined, so left as it is, for every decision that already has its turn list): without it an incident correction can never match the numbered row of a refusal decided here (CodeRabbit on #1025, 14c4e407 pass, N2)
    if (next.state === 'pending') {
      await tx.computerGiveBackDecision.update({
        where: { jobId },
        data: { basis: next.basis, reason: next.reason, route: next.route, judgedTurns: next.judgedTurns, attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + retryWaitMs(current.attempts + 1)), lastError: next.basis },
      });
      return next;
    }
    await tx.computerGiveBackDecision.update({ where: { jobId }, data: { state: next.state, basis: next.basis, reason: next.reason, route: next.route, judgedTurns: next.judgedTurns, nextAttemptAt: null, lastError: null, attempts: { increment: 1 } } });
    if (next.state === 'given') await applyGiveBack(tx, job, next.counted);
    return next;
  });
  if (!verdict) return 'none';
  if (verdict.state === 'given') await giveBackAfter(job, now);
  return verdict.state === 'pending' ? 'pending' : 'resolved';
}

/**
 * The sweep's part: decides the pending decisions that are due, and tells Sentry once about one that has been pending longer than Instant's wait for an
 * unclear run (so a person who is charged provisionally is not forgotten). Never throws.
 */
export async function sweepGiveBackDecisions(now: Date = new Date(), batch = 50): Promise<{ looked: number; resolved: number; alerted: number }> {
  const result = { looked: 0, resolved: 0, alerted: 0 };
  try {
    const due = await prisma.computerGiveBackDecision.findMany({ where: { state: 'pending', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: batch, select: { jobId: true } });
    for (const one of due) {
      result.looked++;
      try {
        if ((await resolveDecision(one.jobId, now)) === 'resolved') result.resolved++;
      } catch (error) {
        console.error('[Computer] Could not decide a give-back again:', error instanceof Error ? error.message : 'unknown');
        // An attempt that throws leaves the next time as it was, so the same oldest rows would be due again at the next sweep and keep every slot from the ones behind them:
        // it is rescheduled with the growing wait like one that could not be decided (guarded: only a row that is still due and still pending is moved)
        const tried = await prisma.computerGiveBackDecision.findUnique({ where: { jobId: one.jobId }, select: { attempts: true } }).catch(() => null);
        await prisma.computerGiveBackDecision
          .updateMany({ where: { jobId: one.jobId, state: 'pending', nextAttemptAt: { lte: now } }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + retryWaitMs((tried?.attempts ?? 0) + 1)), lastError: 'error' } })
          .catch(() => undefined);
      }
    }
    const limits = await readGiveBackLimits();
    const alertAfter = (limits?.unclearWaitMinutes ?? INSTANT_LIMITS_RECOMMENDED.unclearWaitMinutes) * MINUTE;
    const old = await prisma.computerGiveBackDecision.findMany({ where: { state: 'pending', alertedAt: null, decidedAt: { lte: new Date(now.getTime() - alertAfter) } }, take: 20 });
    for (const one of old) {
      // One row's trouble never ends the loop for the rest. The row is locked (FOR UPDATE SKIP LOCKED) in a transaction, Sentry is told INSIDE it, and `alertedAt` is set before the
      // commit: two sweeps never both get the row, and a worker that dies or a capture that throws rolls back, so the next sweep tells it (a duplicate at worst; the mark means handed to Sentry and flushed, not accepted by it: lib/computer-alerts)
      try {
        const told = await prisma.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<Array<{ job_id: string }>>(Prisma.sql`SELECT "job_id" FROM "computer_give_back_decisions" WHERE "job_id" = ${one.jobId} AND "state" = 'pending' AND "alerted_at" IS NULL FOR UPDATE SKIP LOCKED`);
          if (locked.length !== 1) return false;
          await tellSentry(() => Sentry.captureMessage('A computer give-back has been pending for a long time: the person is charged provisionally', { level: 'error', tags: { area: 'computer', step: 'giveback_pending_age', basis: one.basis }, extra: { jobId: one.jobId, since: one.decidedAt.toISOString() } }));
          await tx.computerGiveBackDecision.update({ where: { jobId: one.jobId }, data: { alertedAt: now } });
          return true;
        }, ALERT_TRANSACTION_OPTIONS);
        if (told) result.alerted++;
      } catch (error) {
        console.error('[Computer] Could not tell Sentry about a long-pending give-back (the next sweep tells it):', error instanceof Error ? error.message : 'unknown');
      }
    }
  } catch (error) {
    console.error('[Computer] The give-back sweep failed:', error instanceof Error ? error.message : 'unknown');
  }
  return result;
}

/**
 * The relay's arrival row reached Orbit AFTER a decision named the computer as one that never reached it (`given / universe_fault / relay_unreachable`): the money stays exactly as it is (the decision stays given,
 * a completed refund is never taken back, nothing is charged or given again) and ONLY the reason is told differently, as `relay_reached`, so the receipt no longer says "we couldn't reach our own service". Orbit's
 * own inferred row stays as a record. Nothing changes when the decision rests on positive evidence of an unreachable relay for that run: Orbit's own observation at prepare, or the runner's own marker (an arrival
 * of another run never overrides them, and neither does one of this run: they say a call did not get through). Never a verdict: a refusal is never made a give-back here, and a give-back is never a refusal.
 */
async function relabelReached(jobId: string, run: string | null): Promise<void> {
  if (!(await relayReachedInRun(prisma, jobId, run))) return;
  const rows = await prisma.computerJobFault.findMany({ where: { jobId, kind: 'fault', ...rowsOfRun(run) }, select: { callId: true, reason: true } });
  const positive = rows.some((row) => (row.reason === RELAY_UNREACHABLE && !isInferredUnreachableRow(row)) || isRunnerNoRelayRow(row));
  if (positive) return;
  await prisma.computerGiveBackDecision.updateMany({ where: { jobId, state: 'given', basis: 'universe_fault', reason: RELAY_UNREACHABLE }, data: { reason: RELAY_REACHED } });
}

/**
 * What a batch of ONLY arrival rows does (the relay says a run reached it): nothing is judged and no money moves; a decision that named the computer as one that never reached the relay is re-labelled
 * (`relabelReached`). Never resolves a pending decision and never re-judges a refusal: an arrival is no evidence of any class.
 */
export async function afterArrival(jobId: string): Promise<void> {
  const decision = await prisma.computerGiveBackDecision.findUnique({ where: { jobId }, select: { state: true, basis: true, reason: true, judgedRun: true } });
  if (decision && decision.state === 'given' && decision.basis === 'universe_fault' && decision.reason === RELAY_UNREACHABLE) await relabelReached(jobId, decision.judgedRun);
}

/**
 * New rows arrived for a job that is already over (the relay writes best effort, so one can be late): a decision that was not a give-back is looked at
 * again, and a class 1 fault in what was judged makes it one. A pending decision is decided now. Nothing else ever changes a decision.
 */
export async function afterLateEvidence(jobId: string, now: Date = new Date()): Promise<void> {
  const first = await prisma.computerGiveBackDecision.findUnique({ where: { jobId } });
  // Every failed finish has a decision whatever the runner said (a hint never hides evidence); an Orbit-seen ending has no hint and is already given
  if (!first || !first.causeHint) return;
  if (first.state === 'pending') {
    await resolveDecision(jobId, now);
    return;
  }
  // A give-back that Orbit made because it INFERRED the relay was never reached keeps its money when the relay later says it was: only the reason is told differently
  if (first.state === 'given' && first.basis === 'universe_fault' && first.reason === RELAY_UNREACHABLE) {
    await relabelReached(jobId, first.judgedRun);
    return;
  }
  // Only a goodwill give-back is counted: the other `given` ones are already uncounted, and nothing is left to learn from a late row
  if (first.state === 'given' && first.basis !== 'goodwill') return;
  // The job's own end is read with it: the goodwill count of a late decision is of the month the job ENDED in, whenever the decision is made
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, personId: true, startedAt: true, endedAt: true } });
  if (!job) return;
  // Read before the transaction opens, as at the finish: a read of Limits that fails inside it would leave the transaction aborted. Only a refusal that had no evidence reads them
  const limits = first.state === 'refused' && first.basis === 'agent_ended' ? await readGiveBackLimits() : null;
  const applied = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, job.personId);
    // Read again under the person's lock: a decision made in the meantime (a parallel retry) is the one that stands
    const decision = await tx.computerGiveBackDecision.findUnique({ where: { jobId } });
    // The same verdict as evidence on time: a confirmed fault of ours in what was judged beats a delivered effect (decideRunnerFinish reads class 1 before the effects), so a row that
    // arrives late and says so gives the job back whatever the decision refused it for
    if (!decision || decision.state === 'pending' || (decision.state === 'given' && decision.basis !== 'goodwill')) return false;
    // A decision for a runner that said the agent's own (or nothing) and named no turns looks at the LAST turn with a row, in its run: the one it chose at the finish, or, when nothing had
    // a row yet, the last one now
    const lenient = decision.causeHint !== 'ours';
    let turns: readonly number[] = decision.judgedTurns;
    let turnlessOnly = false;
    // The turn chosen now is KEPT on the decision, as a finish that found the row on time keeps it: the decision then stands on that turn's evidence (an incident correction reads the same rows
    // whichever arrived first, the row or the finish). A turn nobody has judged is never added to a decision that already judged one
    let chosen: number | null = null;
    if (lenient && turns.length === 0) {
      const last = await lastFaultTurn(tx, jobId, decision.judgedRun);
      if (last === null) turnlessOnly = true;
      else {
        turns = [last];
        chosen = last;
      }
    }
    const rows = await readFaultRows(tx, jobId, turns, decision.judgedRun, { turnlessOnly });
    const ours = oursFinding(rows, await relayReachedInRun(tx, jobId, decision.judgedRun));
    if (!ours) {
      // A refusal that rested on NO evidence at all (the agent ended on its own, nothing recorded for what was judged) is judged again, now that there is something to read, EXACTLY as the finish would
      // have judged it had the row been there on time: the same function, with the same rules for the person's own evidence, a delivered effect, an effect still to be confirmed, the person's
      // bound and the pause, the month the job ended in, and under the same lock. A refusal that rested on evidence (cap, pause, delivered, the person's own) stays as it was
      if (decision.state === 'refused' && decision.basis === 'agent_ended') {
        const again = await decideRunnerFinish(tx, limits, job, chosen !== null ? [chosen] : turns, now, { run: decision.judgedRun, hint: hintOf(decision.causeHint) });
        if (again.state === 'refused' && again.basis === 'agent_ended') {
          if (chosen !== null) await tx.computerGiveBackDecision.update({ where: { jobId }, data: { judgedTurns: [chosen] } });
          return false;
        }
        // Written as the finish writes it (one row per job, the hint and the run kept), then the give-back is made as the finish makes it: the job's time is written against nobody, once
        await writeDecision(tx, job, again, decision.causeHint ?? 'ours', again.judgedTurns ?? (chosen !== null ? [chosen] : turns), now, decision.judgedRun);
        if (again.state !== 'given') return false;
        await applyGiveBack(tx, job, again.counted);
        return true;
      }
      if (chosen !== null) await tx.computerGiveBackDecision.update({ where: { jobId }, data: { judgedTurns: [chosen] } });
      return false;
    }
    await tx.computerGiveBackDecision.update({ where: { jobId }, data: { state: 'given', basis: 'universe_fault', reason: ours.reason, route: ours.route, nextAttemptAt: null, ...(chosen !== null ? { judgedTurns: [chosen] } : {}) } });
    if (decision.state === 'given') {
      // It was counted against the person's bound as goodwill, and a fault of ours (it names no one's words) uses none of it: un-counted, nothing else to give back
      await uncountGiveBack(tx, jobId);
      return false;
    }
    await applyGiveBack(tx, job, false);
    return true;
  });
  if (applied) await giveBackAfter(job, now);
}

/** How far before a decision's last change a fault row may have been written and still be looked at again: a row is written by a write that began before the decision was committed (the two overlap). */
const LATE_ROW_MARGIN_MINUTES = 5;
/** How old a decision may be and still be looked at again for a late row. */
const LATE_ROW_HORIZON_DAYS = 30;

/** What a late look that threw leaves in `lastError` (then `:` and the time of its first failure, in ms); `late_look_told` once Sentry has been told it keeps failing. */
const LATE_LOOK = 'late_look';
const LATE_LOOK_TOLD = 'late_look_told';
/** How long a late look may keep failing before Sentry is told. */
const LATE_LOOK_ALERT_MS = 60 * MINUTE;

/**
 * Evidence that reached Orbit while a decision was being made is not lost: the sweep looks again, with `afterLateEvidence`, at every decision a fault row of ours is newer than (a
 * refusal, or goodwill that was counted), so a row that was stored a moment before the finish committed, and found no decision to judge, is judged all the same. The route that stores
 * a row answers once it is stored, whatever this does. A decision looked at is marked as looked at (the time this look began, taken before it read anything), so it is not looked at again
 * until another row arrives; rows written within a few minutes before that mark are looked at once more, because a write that began before it may have committed after it.
 *
 * A look that THROWS is never dropped: the decision is marked and given a retry time with the growing wait (`attempts`, `nextAttemptAt`, `lastError` = late_look:<first failure>), and the sweep
 * picks it by that time however old its rows are, until a look succeeds (which clears all three). The decision sweep reads `nextAttemptAt` of PENDING decisions only, so on these it is only this.
 * Sentry is told once (the alert is claimed first) when a look has been failing for an hour. Never throws.
 */
export async function sweepLateEvidence(now: Date = new Date(), batch = 50): Promise<{ looked: number }> {
  const result = { looked: 0 };
  try {
    // The mark is the UTC wall time the columns hold (a database that is not set to UTC would otherwise read it ahead or behind, and a row that arrives after the look would look older than the mark)
    const due = await prisma.$queryRaw<Array<{ job_id: string; mark: Date; attempts: number; last_error: string | null }>>(Prisma.sql`
      SELECT d."job_id", clock_timestamp() AT TIME ZONE 'UTC' AS mark, d."attempts", d."last_error" FROM "computer_give_back_decisions" d
      WHERE d."cause_hint" IS NOT NULL AND (d."state" = 'refused' OR (d."state" = 'given' AND d."basis" = 'goodwill') OR (d."state" = 'given' AND d."basis" = 'universe_fault' AND d."reason" = 'relay_unreachable'))
        AND (
          -- A look that threw is retried at its own time, however old the decision is: it is never dropped
          (d."last_error" LIKE 'late_look%' AND d."next_attempt_at" <= ${now})
          -- New evidence: a fault row that arrived within the horizon and after the decision was last looked at. The horizon is the NEW row's age, not the decision's: a row
          -- that arrives for an old decision (an uncertain row confirmed long after) is evidence all the same
          OR (COALESCE(d."last_error", '') NOT LIKE 'late_look%' AND EXISTS (
            SELECT 1 FROM "computer_job_faults" f WHERE f."job_id" = d."job_id"
              -- An answered call (the relay's arrival row on nearly every turn included) says nothing wrong: it is new evidence only for the decision that named the relay unreachable, whose reason it re-labels
              AND (f."kind" <> 'answered' OR (f."reason" = 'relay_reached' AND f."source" = 'universe-ai' AND d."reason" = 'relay_unreachable'))
              AND f."created_at" > ${new Date(now.getTime() - LATE_ROW_HORIZON_DAYS * 24 * 60 * MINUTE)}
              AND f."created_at" > d."updated_at" - ${Prisma.raw(`interval '${LATE_ROW_MARGIN_MINUTES} minutes'`)}))
        )
      ORDER BY d."updated_at" ASC LIMIT ${batch}`);
    for (const one of due) {
      result.looked++;
      try {
        await afterLateEvidence(one.job_id, now);
        // Marked as looked at as of when this look began: a row that arrives from here on is newer than the mark. A look that succeeds ends the retry of an earlier one that threw,
        // but ONLY the retry this look read (its attempts and its marker): a look that failed while this one was running has recorded a NEWER retry, which this older success
        // must not clear (the evidence it is for may be older than the mark, and nothing else would pick it up again). The mark still advances
        const sameRetry = Prisma.sql`"last_error" LIKE 'late_look%' AND "attempts" = ${one.attempts} AND "last_error" IS NOT DISTINCT FROM ${one.last_error}`;
        await prisma.$executeRaw(Prisma.sql`
          UPDATE "computer_give_back_decisions"
          SET "updated_at" = GREATEST("updated_at", ${one.mark}),
              "next_attempt_at" = CASE WHEN ${sameRetry} THEN NULL ELSE "next_attempt_at" END,
              "last_error" = CASE WHEN ${sameRetry} THEN NULL ELSE "last_error" END
          WHERE "job_id" = ${one.job_id}`);
      } catch (error) {
        console.error('[Computer] Could not look at late evidence again:', error instanceof Error ? error.message : 'unknown');
        await lateLookFailed(one.job_id, one.mark, now);
      }
    }
  } catch (error) {
    console.error('[Computer] The late evidence sweep failed:', error instanceof Error ? error.message : 'unknown');
  }
  return result;
}

/** A late look threw: marked, rescheduled with the growing wait, and Sentry told once when it has been failing for an hour. Never throws. */
async function lateLookFailed(jobId: string, mark: Date, now: Date): Promise<void> {
  try {
    const row = (await prisma.$queryRaw<Array<{ attempts: number; last_error: string | null }>>(Prisma.sql`SELECT "attempts", "last_error" FROM "computer_give_back_decisions" WHERE "job_id" = ${jobId}`))[0];
    if (!row) return;
    const previous = row.last_error?.startsWith(LATE_LOOK) ? row.last_error : null;
    const told = previous?.startsWith(LATE_LOOK_TOLD) ?? false;
    const first = (previous ? Number(previous.split(':')[1]) : NaN) || now.getTime();
    const marker = `${told ? LATE_LOOK_TOLD : LATE_LOOK}:${first}`;
    const next = new Date(now.getTime() + retryWaitMs(row.attempts + 1));
    // Written only over the state this attempt read (the marker AND the count of attempts): another sweep that told Sentry, or failed over the same marker, in the meantime has the
    // newer word, and an older one never overwrites it (that would fire the alert again, or move the deadline back)
    const rescheduled = await prisma.$executeRaw`
      UPDATE "computer_give_back_decisions"
      SET "updated_at" = GREATEST("updated_at", ${mark}), "attempts" = "attempts" + 1, "next_attempt_at" = ${next}, "last_error" = ${marker}
      WHERE "job_id" = ${jobId} AND "state" IN ('refused', 'given') AND "last_error" IS NOT DISTINCT FROM ${row.last_error} AND "attempts" = ${row.attempts}`;
    if (rescheduled !== 1 || told || now.getTime() - first < LATE_LOOK_ALERT_MS) return;
    // Told once, by the same shape as the other alerts: the row is locked (FOR UPDATE SKIP LOCKED) while its marker is still the one just written, Sentry is told (and flushed) inside the
    // transaction (lib/computer-alerts), and `late_look_told` is set before the commit. A sweep that finds it locked skips it; a capture that throws or a worker that dies rolls back, and the next
    // failing look tells it (a duplicate at worst; the mark means handed to Sentry and flushed, not accepted by it: lib/computer-alerts)
    const toldMarker = `${LATE_LOOK_TOLD}:${first}`;
    try {
      await prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ job_id: string }>>(Prisma.sql`SELECT "job_id" FROM "computer_give_back_decisions" WHERE "job_id" = ${jobId} AND "last_error" = ${marker} FOR UPDATE SKIP LOCKED`);
        if (locked.length !== 1) return;
        await tellSentry(() => Sentry.captureMessage('A late look at evidence for a computer give-back has been failing for over an hour: a confirmed fault of ours may still be charged to a person', { level: 'error', tags: { area: 'computer', step: 'giveback_late_look' }, extra: { jobId, since: new Date(first).toISOString() } }));
        await tx.$executeRaw`UPDATE "computer_give_back_decisions" SET "last_error" = ${toldMarker} WHERE "job_id" = ${jobId}`;
      }, ALERT_TRANSACTION_OPTIONS);
    } catch (error) {
      console.error('[Computer] Could not tell Sentry about a failing late look (the next failing look tells it):', error instanceof Error ? error.message : 'unknown');
    }
  } catch (error) {
    console.error('[Computer] Could not reschedule a failing late look:', error instanceof Error ? error.message : 'unknown');
  }
}

/**
 * A Brick is about to be purged: its jobs and their fault rows go with it, so nothing more can be learned for a decision still waiting. Each is decided now
 * with its outside effects closed, and one that still cannot be decided (the Limits unreadable or not set) is given back, uncounted, in the person's favour:
 * never a final charge. Returns false when one could not be written yet (the Brick waits for the next sweep). Never throws.
 */
export async function decidePendingForPurge(botId: string, now: Date = new Date(), batch = 500): Promise<boolean> {
  try {
    const waiting = await prisma.$queryRaw<Array<{ job_id: string }>>(Prisma.sql`
      SELECT d."job_id" FROM "computer_give_back_decisions" d JOIN "computer_jobs" j ON j."id" = d."job_id" WHERE d."state" = 'pending' AND j."bot_id" = ${botId} LIMIT ${batch}`);
    for (const one of waiting) await resolveDecision(one.job_id, now, { closing: true });
    // A batch is bounded, so more may wait than it took: the purge goes on only when none is left (it must never remove the last job and its evidence before the verdict)
    const left = await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS n FROM "computer_give_back_decisions" d JOIN "computer_jobs" j ON j."id" = d."job_id" WHERE d."state" = 'pending' AND j."bot_id" = ${botId}`);
    return (left[0]?.n ?? 0) === 0;
  } catch (error) {
    console.error('[Computer] Could not decide a Brick’s give-backs before its purge:', error instanceof Error ? error.message : 'unknown');
    return false;
  }
}

/** A give-back made while an effect was unconfirmed is told it was delivered: kept as a fact for support, never taking the give-back back. Inside the caller's transaction, so it commits with the effect's own change. */
export async function markDeliveredLate(tx: Prisma.TransactionClient, jobId: string): Promise<void> {
  await tx.computerGiveBackDecision.updateMany({ where: { jobId, state: 'given', basis: 'goodwill' }, data: { deliveredLate: true } });
}

/**
 * An outside effect of a job was settled. A decision held for an unconfirmed effect is decided now: done means none, failed means the goodwill rules go on.
 * (That a give-back already made was for work that turned out delivered is written down WITH the effect's own change, `markDeliveredLate`, so the two never
 * come apart: a settle whose flag cannot be written is not a settle, and is asked again.)
 */
export async function noteEffectSettled(jobId: string): Promise<void> {
  const decision = await prisma.computerGiveBackDecision.findUnique({ where: { jobId }, select: { state: true, basis: true } });
  if (decision?.state === 'pending' && decision.basis === 'effect_unresolved') await resolveDecision(jobId).catch(() => undefined);
}
