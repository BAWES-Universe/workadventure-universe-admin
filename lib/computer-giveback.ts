import { Prisma } from '@prisma/client';
import * as Sentry from '@sentry/nextjs';
import { prisma } from '@/lib/db';
import { getInstantLimitsStrict } from '@/lib/instant/state';
import { INSTANT_LIMITS_RECOMMENDED, type InstantLimits } from '@/lib/instant/values';
import { monthOf } from '@/lib/meter-values';
import { giveBackModelCalls } from '@/lib/computer-calls';
import { readFaultRows } from '@/lib/computer-faults';

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
  if (limits.pauseMinRuns === null || limits.pauseFailureRateBps === null) out.push('Instant’s pause numbers are not set, so a provider failing for many people cannot pause new platform-funded computer work.');
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

/** The wait before a pending decision is tried again: one minute, growing to an hour. */
export const retryWaitMs = (attempts: number): number => Math.min(2 ** Math.max(0, attempts), 60) * MINUTE;

interface JobRef {
  id: string;
  personId: string;
  startedAt: Date | null;
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
  options: { effectsClosed?: boolean } = {},
): Promise<Verdict> {
  const rows = await readFaultRows(tx, job.id, turns);
  const ours = rows.find((row) => row.cls === 'ours');
  // Nothing was charged for a job that never started: there is nothing to hold back
  if (!job.startedAt) return { state: 'given', basis: 'universe_fault', counted: false, reason: ours?.reason ?? 'not_started', route: ours?.route ?? null };
  // Class 1: any bad turn of ours makes the ending ours
  if (ours) return { state: 'given', basis: 'universe_fault', counted: false, reason: ours.reason, route: ours.route };
  const person = rows.find((row) => row.cls === 'person');
  const unresolved = rows.find((row) => row.cls === 'unresolved');
  // Class 2: evidence it was the person's, and nothing that points at us
  if (person && !unresolved) return { state: 'refused', basis: 'person_caused', reason: person.reason, route: person.route };

  // Class 3: bounded goodwill
  const reason = unresolved?.reason ?? null;
  const route = unresolved?.route ?? null;
  if ((await tx.computerEffect.count({ where: { jobId: job.id, state: 'done' } })) > 0) return { state: 'refused', basis: 'delivered', reason, route };
  if (!options.effectsClosed && (await tx.computerEffect.count({ where: { jobId: job.id, state: 'planned' } })) > 0) return { state: 'pending', basis: 'effect_unresolved', reason, route };
  if (!limits) return { state: 'pending', basis: 'limits_unreadable', reason, route };
  const bound = personGiveBackBound(limits);
  if (bound === null) return { state: 'pending', basis: 'limits_missing', reason, route };

  const month = monthOf(now);
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
): Promise<void> {
  const data = {
    state: verdict.state,
    basis: verdict.basis,
    causeHint: hint,
    reason: verdict.reason,
    route: verdict.route,
    judgedTurns: [...(turns ?? [])],
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

/** The calls and credit of a job that was given back. Never throws. */
export async function giveBackAfter(job: { id: string; personId: string }): Promise<void> {
  await giveBackModelCalls(job.id, job.personId).catch((error) => console.error('[Computer] Could not give back a job’s model calls:', error instanceof Error ? error.message : 'unknown'));
}

/**
 * Decides a `pending` decision again (limits now readable or set, an outside effect now confirmed or closed). A decision that is still not possible stays
 * pending with a longer wait; one that is `given` gives back everything the job took. Safe to say twice.
 */
export async function resolveDecision(jobId: string, now: Date = new Date()): Promise<'resolved' | 'pending' | 'none'> {
  const decision = await prisma.computerGiveBackDecision.findUnique({ where: { jobId } });
  if (!decision || decision.state !== 'pending') return 'none';
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, personId: true, startedAt: true } });
  if (!job) {
    await prisma.computerGiveBackDecision.update({ where: { jobId }, data: { state: 'refused', nextAttemptAt: null, lastError: 'The job was removed before it could be decided' } });
    return 'resolved';
  }
  const limits = await readGiveBackLimits();
  const closeAfter = (limits?.unreachableWaitMinutes ?? INSTANT_LIMITS_RECOMMENDED.unreachableWaitMinutes) * MINUTE;
  const effectsClosed = now.getTime() - decision.decidedAt.getTime() >= closeAfter;
  const verdict = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, job.personId);
    const next = await decideRunnerFinish(tx, limits, job, decision.judgedTurns, now, { effectsClosed });
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
  if (verdict.state === 'given') await giveBackAfter(job);
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
      }
    }
    const limits = await readGiveBackLimits();
    const alertAfter = (limits?.unclearWaitMinutes ?? INSTANT_LIMITS_RECOMMENDED.unclearWaitMinutes) * MINUTE;
    const old = await prisma.computerGiveBackDecision.findMany({ where: { state: 'pending', alertedAt: null, decidedAt: { lte: new Date(now.getTime() - alertAfter) } }, take: 20 });
    for (const one of old) {
      Sentry.captureMessage('A computer give-back has been pending for a long time: the person is charged provisionally', { level: 'error', tags: { area: 'computer', step: 'giveback_pending_age', basis: one.basis }, extra: { jobId: one.jobId, since: one.decidedAt.toISOString() } });
      await prisma.computerGiveBackDecision.update({ where: { jobId: one.jobId }, data: { alertedAt: now } });
      result.alerted++;
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
  const decision = await prisma.computerGiveBackDecision.findUnique({ where: { jobId } });
  if (!decision || decision.state === 'given' || decision.causeHint !== 'ours') return;
  if (decision.state === 'pending') {
    await resolveDecision(jobId, now);
    return;
  }
  const job = await prisma.computerJob.findUnique({ where: { id: jobId }, select: { id: true, personId: true, startedAt: true } });
  if (!job) return;
  const applied = await prisma.$transaction(async (tx) => {
    await lockPerson(tx, job.personId);
    const rows = await readFaultRows(tx, jobId, decision.judgedTurns);
    const ours = rows.find((row) => row.cls === 'ours');
    if (!ours) return false;
    await tx.computerGiveBackDecision.update({ where: { jobId }, data: { state: 'given', basis: 'universe_fault', reason: ours.reason, route: ours.route, nextAttemptAt: null } });
    await applyGiveBack(tx, job, false);
    return true;
  });
  if (applied) await giveBackAfter(job);
}

/**
 * An outside effect of a job was settled. If it is done and the job was already given back as goodwill while it was unconfirmed (or past the bounded close),
 * that is kept as a fact for support; it never takes a give-back back. A decision held for an unconfirmed effect is decided now: done means none, failed
 * means the goodwill rules go on.
 */
export async function noteEffectSettled(jobId: string, state: 'done' | 'failed'): Promise<void> {
  if (state === 'done') await prisma.computerGiveBackDecision.updateMany({ where: { jobId, state: 'given', basis: 'goodwill' }, data: { deliveredLate: true } });
  const decision = await prisma.computerGiveBackDecision.findUnique({ where: { jobId }, select: { state: true, basis: true } });
  if (decision?.state === 'pending' && decision.basis === 'effect_unresolved') await resolveDecision(jobId).catch(() => undefined);
}
