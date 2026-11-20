import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';
import { ALERT_TRANSACTION_OPTIONS, tellSentry } from '@/lib/computer-alerts';
import { prisma } from '@/lib/db';
import { getInstantLimitsStrict } from '@/lib/instant/state';
import { INSTANT_LIMITS_RECOMMENDED, type InstantLimits } from '@/lib/instant/values';
import { monthOf } from '@/lib/meter-values';
import { giveBackModelCalls } from '@/lib/computer-calls';
import { OURS_REASONS, readFaultRows } from '@/lib/computer-faults';
import { incidentFaultMatch } from '@/lib/computer-route-pause';
import { retryWaitMs } from '@/lib/computer-retry';

/**
 * Whether a computer job that failed is given back, and the kept record of why (table computer_give_back_decisions).
 *
 * A job's words are the person's, so a brief can make the agent do the work and then crash its own machine, and that looks like a failure of ours. Money
 * therefore depends on what the failure was, judged by Orbit from the relay's durable rows (lib/computer-faults) when the computer's runner reports a
 * failure with cause "ours" (its cause is only a hint). Three classes:
 *
 *  1. A fault only OURS can cause (relay side, or the provider refusing our key): ALWAYS given back, never counted. If any bad turn of the failed streak
 *     was one, the ending is ours, whatever else happened in it.
 *  2. A fault the PERSON caused, with evidence (their allowance, a rule, their own key, a field their job set): charged like any run.
 *  3. UNRESOLVED (a crash with nothing noted, a provider 5xx or 429, a timeout, a 400 with no field): bounded goodwill, decided as follows.
 *     - A job that settled something outside its computer as done delivered: nothing is given back.
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
  | { state: 'given'; basis: 'universe_fault' | 'goodwill' | 'orbit_fault' | 'incident'; counted: boolean; reason: string | null; route: string | null }
  | { state: 'refused'; basis: 'person_caused' | 'delivered' | 'cap' | 'paused'; reason: string | null; route: string | null }
  | { state: 'pending'; basis: 'effect_unresolved' | 'limits_unreadable' | 'limits_missing'; reason: string | null; route: string | null };

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
  options: { effectsClosed?: boolean; run?: string | null } = {},
): Promise<Verdict> {
  const rows = await readFaultRows(tx, job.id, turns, options.run);
  const ours = rows.find((row) => row.cls === 'ours');
  // Nothing was charged for a job that never started: there is nothing to hold back
  if (!job.startedAt) return { state: 'given', basis: 'universe_fault', counted: false, reason: ours?.reason ?? 'not_started', route: ours?.route ?? null };
  // Class 1: any bad turn of ours makes the ending ours
  if (ours) return { state: 'given', basis: 'universe_fault', counted: false, reason: ours.reason, route: ours.route };
  const person = rows.find((row) => row.cls === 'person');
  // A turn the runner judged failed that has no row at all (a crash, a stream that broke) is unresolved, never the person's
  const silent = turns && turns.length > 0 ? turns.find((turn) => !rows.some((row) => row.turn === turn)) : undefined;
  const unresolved = rows.find((row) => row.cls === 'unresolved') ?? (silent !== undefined ? { reason: 'no_row', route: null } : undefined);
  // Class 2: evidence it was the person's, and nothing that points at us
  if (person && !unresolved) return { state: 'refused', basis: 'person_caused', reason: person.reason, route: person.route };

  // Class 3: bounded goodwill
  const reason = unresolved?.reason ?? null;
  const route = unresolved?.route ?? null;
  // Both states are read in ONE statement, so a send that turns from planned to done between two reads can never be seen as neither: one done blocks goodwill, one still
  // planned (and none done) defers the decision
  const effects = await tx.computerEffect.groupBy({ by: ['state'], where: { jobId: job.id, state: { in: ['done', 'planned'] } }, _count: { _all: true } });
  if (effects.some((one) => one.state === 'done')) return { state: 'refused', basis: 'delivered', reason, route };
  if (!options.effectsClosed && effects.some((one) => one.state === 'planned')) return { state: 'pending', basis: 'effect_unresolved', reason, route };
  if (!limits) return { state: 'pending', basis: 'limits_unreadable', reason, route };
  const bound = personGiveBackBound(limits);
  if (bound === null) return { state: 'pending', basis: 'limits_missing', reason, route };

  // The month the job ended in, not the month the decision is made in: a job that ended on the 31st and is decided on the 1st uses the 31st's month, for both counts
  const month = monthOf(job.endedAt ?? now);
  const ran = { personId: job.personId, id: { not: job.id }, startedAt: { not: null }, endedAt: { gte: month.start, lt: month.end } };
  const [given, ended] = await Promise.all([
    // Only goodwill gives count: a fault of ours, an outage and an incident correction use none of a person's bound
    tx.computerJob.count({ where: { ...ran, status: { in: ['failed', 'stopped'] }, endedBy: 'error', runnerFault: true } }),
    // Jobs that ended after running, but not the ones the person ended themselves or turned off: those say nothing about how the work goes
    tx.computerJob.count({ where: { ...ran, status: { in: ['done', 'failed', 'stopped'] }, OR: [{ endedBy: null }, { endedBy: { notIn: ['person', 'off', 'deleted'] } }] } }),
  ]);
  if (given >= bound) return { state: 'refused', basis: 'cap', reason, route };
  if (personGiveBackPaused(limits, ended, given)) return { state: 'refused', basis: 'paused', reason, route };
  return { state: 'given', basis: 'goodwill', counted: true, reason, route };
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
    judgedRun: turns && turns.length > 0 ? (run ?? null) : null,
    nextAttemptAt: verdict.state === 'pending' ? new Date(now.getTime() + retryWaitMs(0)) : null,
  };
  await tx.computerGiveBackDecision.upsert({ where: { jobId: job.id }, create: { jobId: job.id, personId: job.personId, ...data }, update: data });
}

/** An ending Orbit saw itself is always given back; it is recorded so support and the operations view see it with the rest. */
export async function writeOrbitDecision(tx: Prisma.TransactionClient, job: { id: string; personId: string }): Promise<void> {
  await tx.computerGiveBackDecision.upsert({
    where: { jobId: job.id },
    create: { jobId: job.id, personId: job.personId, state: 'given', basis: 'orbit_fault', causeHint: null, reason: null, route: null, judgedTurns: [] },
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
  // Delivered work is left alone: a job with an outside effect that is done is never turned into a give-back by a correction (a held decision stays held, and is decided by its
  // evidence). This blocks only that flip: a goodwill give-back already made (counted against the person's bound) is freed from the bound above, delivered or not, because the
  // correction lifts the bound and does not change the verdict
  if ((await tx.computerEffect.count({ where: { jobId: job.id, state: 'done' } })) > 0) return null;
  const flipped = await tx.computerGiveBackDecision.updateMany({
    where: { jobId: job.id, OR: [{ state: 'pending' }, { state: 'refused', basis: { in: ['cap', 'paused'] } }] },
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
    // Read again under the person's lock: an incident correction (or another retry) may have decided it since the read above, and that decision stands
    const current = await tx.computerGiveBackDecision.findUnique({ where: { jobId }, select: { state: true } });
    if (!current || current.state !== 'pending') return null;
    let next = await decideRunnerFinish(tx, limits, job, decision.judgedTurns, now, { effectsClosed, run: decision.judgedRun });
    // Limits that cannot be read or are not set cannot be waited out when the evidence is about to be deleted: the person is not charged for it
    if (options.closing && next.state === 'pending') next = { state: 'given', basis: 'orbit_fault', counted: false, reason: 'brick_purged', route: next.route };
    if (next.state === 'pending') {
      await tx.computerGiveBackDecision.update({
        where: { jobId },
        data: { basis: next.basis, reason: next.reason, route: next.route, attempts: { increment: 1 }, nextAttemptAt: new Date(now.getTime() + retryWaitMs(decision.attempts + 1)), lastError: next.basis },
      });
      return next;
    }
    await tx.computerGiveBackDecision.update({ where: { jobId }, data: { state: next.state, basis: next.basis, reason: next.reason, route: next.route, nextAttemptAt: null, lastError: null, attempts: { increment: 1 } } });
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
      // commit: two sweeps never both get the row, and a worker that dies or a capture that throws rolls back, so the next sweep tells it (a duplicate at worst, never a lost alert)
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
 * New rows arrived for a job that is already over (the relay writes best effort, so one can be late): a decision that was not a give-back is looked at
 * again, and a class 1 fault in what was judged makes it one. A pending decision is decided now. Nothing else ever changes a decision.
 */
export async function afterLateEvidence(jobId: string, now: Date = new Date()): Promise<void> {
  const first = await prisma.computerGiveBackDecision.findUnique({ where: { jobId } });
  if (!first || first.causeHint !== 'ours') return;
  if (first.state === 'pending') {
    await resolveDecision(jobId, now);
    return;
  }
  // Only a goodwill give-back is counted: the other `given` ones are already uncounted, and nothing is left to learn from a late row
  if (first.state === 'given' && first.basis !== 'goodwill') return;
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, personId: true, startedAt: true } });
  if (!job) return;
  const applied = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, job.personId);
    // Read again under the person's lock: a decision made in the meantime (a parallel retry) is the one that stands
    const decision = await tx.computerGiveBackDecision.findUnique({ where: { jobId } });
    // The same verdict as evidence on time: a confirmed fault of ours in what was judged beats a delivered effect (decideRunnerFinish reads class 1 before the effects), so a row that
    // arrives late and says so gives the job back whatever the decision refused it for
    if (!decision || decision.state === 'pending' || (decision.state === 'given' && decision.basis !== 'goodwill')) return false;
    const rows = await readFaultRows(tx, jobId, decision.judgedTurns, decision.judgedRun);
    const ours = rows.find((row) => row.cls === 'ours');
    if (!ours) return false;
    await tx.computerGiveBackDecision.update({ where: { jobId }, data: { state: 'given', basis: 'universe_fault', reason: ours.reason, route: ours.route, nextAttemptAt: null } });
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
    const due = await prisma.$queryRaw<Array<{ job_id: string; mark: Date }>>(Prisma.sql`
      SELECT d."job_id", clock_timestamp() AS mark FROM "computer_give_back_decisions" d
      WHERE d."cause_hint" = 'ours' AND (d."state" = 'refused' OR (d."state" = 'given' AND d."basis" = 'goodwill'))
        AND (
          -- A look that threw is retried at its own time, however old the decision is: it is never dropped
          (d."last_error" LIKE 'late_look%' AND d."next_attempt_at" <= ${now})
          -- New evidence: a fault row that arrived within the horizon and after the decision was last looked at. The horizon is the NEW row's age, not the decision's: a row
          -- that arrives for an old decision (an uncertain row confirmed long after) is evidence all the same
          OR (COALESCE(d."last_error", '') NOT LIKE 'late_look%' AND EXISTS (
            SELECT 1 FROM "computer_job_faults" f WHERE f."job_id" = d."job_id"
              AND f."created_at" > ${new Date(now.getTime() - LATE_ROW_HORIZON_DAYS * 24 * 60 * MINUTE)}
              AND f."created_at" > d."updated_at" - ${Prisma.raw(`interval '${LATE_ROW_MARGIN_MINUTES} minutes'`)}))
        )
      ORDER BY d."updated_at" ASC LIMIT ${batch}`);
    for (const one of due) {
      result.looked++;
      try {
        await afterLateEvidence(one.job_id, now);
        // Marked as looked at as of when this look began: a row that arrives from here on is newer than the mark. A look that succeeds ends any retry of an earlier one that threw
        await prisma.$executeRaw`
          UPDATE "computer_give_back_decisions"
          SET "updated_at" = GREATEST("updated_at", ${one.mark}),
              "next_attempt_at" = CASE WHEN "last_error" LIKE 'late_look%' THEN NULL ELSE "next_attempt_at" END,
              "last_error" = CASE WHEN "last_error" LIKE 'late_look%' THEN NULL ELSE "last_error" END
          WHERE "job_id" = ${one.job_id}`;
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
    // failing look tells it (a duplicate at worst, never a lost alert)
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
