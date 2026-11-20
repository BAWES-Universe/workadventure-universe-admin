import type { Prisma } from '@prisma/client';
import { getInstantLimits } from '@/lib/instant/state';
import type { InstantLimits } from '@/lib/instant/values';
import { monthOf } from '@/lib/meter-values';

/**
 * Whether a computer job that ended on our side (`ended_by = 'error'`) is given back.
 *
 * A job's words are the person's, so a brief can make the agent do the work and then crash its own machine. That ends as "ours", and without a bound the
 * person would get all of it back though the work was seen. So a give-back is bounded the way Instant's "Didn't work" give-back is, from the same Limits,
 * and nothing new is set anywhere:
 *
 *  - Nothing is given back for a job that already settled something outside its computer as done (a send, a publish, a payment…): that job delivered.
 *  - A person has a bounded number of give-backs a month (UTC). It is Instant's "Give-backs one person may have in a month" when a super admin set it.
 *    Left empty (as it is at launch: Instant's own button is gone), it is what Instant's pause rule itself tolerates among its smallest batch of runs:
 *    "pauseMinRuns" runs at "pauseFailureRateBps" of them, the number of failures that rule lets pass before it pauses.
 *  - A person whose give-backs are repeated is paused on their own, by Instant's pause rule applied to their own month: once they have had at least
 *    "pauseMinRuns" jobs end, and the share given back reached "pauseFailureRateBps", nothing more is given back to them. It lifts by itself as the
 *    share falls (more jobs that ran well) or on the 1st.
 *
 * Real outages stay given back inside that bound. People's own keys are never touched here: a call on a person's own key is never drawn from them, so
 * there is nothing of it to give back or to limit. Universe AI chat, direct messages and voice never come through here.
 *
 * With no pause numbers in Limits at all (a super admin emptied them; Instant would then refuse to run) there is no bound to read, and a failure on our
 * side is given back as it always was.
 */

export type GiveBackVerdict = { give: true } | { give: false; why: 'outside_effect' | 'person_limit' | 'paused' };

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

/**
 * Decides whether this job's ending as ours is given back. Run inside the transaction that writes the ending, after the person's give-back lock is
 * taken, so two jobs of one person ending together cannot both take the last give-back. A job that never started ran nothing: it is given back
 * (nothing was charged to give) and uses none of the bound.
 */
export async function judgeJobGiveBack(tx: Prisma.TransactionClient, job: { id: string; personId: string; startedAt: Date | null }, now: Date): Promise<GiveBackVerdict> {
  if (!job.startedAt) return { give: true };
  // The job delivered something outside its computer: the work was done, so none of it is given back, whatever happened to the machine afterwards
  if ((await tx.computerEffect.count({ where: { jobId: job.id, state: 'done' } })) > 0) return { give: false, why: 'outside_effect' };

  const limits = await getInstantLimits(tx);
  const bound = personGiveBackBound(limits);
  if (bound === null) return { give: true };

  const month = monthOf(now);
  const ran = { personId: job.personId, id: { not: job.id }, startedAt: { not: null }, endedAt: { gte: month.start, lt: month.end } };
  const [given, ended] = await Promise.all([
    tx.computerJob.count({ where: { ...ran, status: { in: ['failed', 'stopped'] }, endedBy: 'error' } }),
    // Jobs that ended after running, but not the ones the person ended themselves or turned off: those say nothing about how the work goes
    tx.computerJob.count({ where: { ...ran, status: { in: ['done', 'failed', 'stopped'] }, OR: [{ endedBy: null }, { endedBy: { notIn: ['person', 'off', 'deleted'] } }] } }),
  ]);
  if (given >= bound) return { give: false, why: 'person_limit' };
  if (personGiveBackPaused(limits, ended, given)) return { give: false, why: 'paused' };
  return { give: true };
}
