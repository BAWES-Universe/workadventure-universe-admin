import type { Prisma } from '@prisma/client';
import type { InstantLimits } from '@/lib/instant/values';
import { monthOf } from '@/lib/meter-values';

/**
 * Whether a computer job that the runner reported as failing on our side (`finishJob` with cause "ours") is given back.
 * Only that ending goes through here: it is the only one the job's own words can steer. Endings Orbit saw itself (a room that lapsed because the bot server
 * stopped renewing, a room closed, a machine that would not start or wake) are always given back, whatever the bound, so a real outage is never refused.
 * Those endings are stored the same way and so do count among the person's give-backs this month (there is no marker to tell them apart).
 *
 * A job's words are the person's, so a brief can make the agent do the work and then crash its own machine. That ends as "ours", and without a bound the
 * person would get all of it back though the work was seen. So a give-back is bounded the way Instant's "Didn't work" give-back is, from the same Limits,
 * and nothing new is set anywhere:
 *
 *  - Nothing is given back for a job that settled something outside its computer as done (a send, a publish, a payment…) or tried one whose outcome is not
 *    known yet: that job delivered, or may have, and a late "done" cannot take a give-back back. An effect confirmed not done does not count.
 *  - A person has a bounded number of give-backs a month (UTC). It is Instant's "Give-backs one person may have in a month" when a super admin set it.
 *    Left empty (as it is at launch: Instant's own button is gone), or 0 (read as empty, as Instant reads it), it is what Instant's pause rule itself tolerates among its smallest batch of runs:
 *    "pauseMinRuns" runs at "pauseFailureRateBps" of them, the number of failures that rule lets pass before it pauses.
 *  - A person whose give-backs are repeated is paused on their own, by Instant's pause rule applied to their own month: once they have had at least
 *    "pauseMinRuns" jobs end, and the share given back reached "pauseFailureRateBps", nothing more is given back to them. It lifts by itself as the
 *    share falls (more jobs that ran well) or on the 1st. With the bound read from the pause numbers (the launch case) it NEVER fires: the give-backs
 *    needed to reach the share (at least floor(pauseMinRuns x share)) are already past the bound. It only matters when a super admin sets a higher
 *    Instant per-person number, and then the bound is not the gate.
 *
 * Real outages stay given back inside that bound. People's own keys are never touched here: a call on a person's own key is never drawn from them, so
 * there is nothing of it to give back or to limit. Universe AI chat, direct messages and voice never come through here.
 *
 * With no pause numbers in Limits at all (a super admin emptied them; Instant would then refuse to run) there is no bound to read, and a failure on our
 * side is given back as it always was.
 */

/** Read from Limits by the caller BEFORE its transaction opens: a read that fails inside a transaction leaves the transaction aborted. */
export type GiveBackLimits = Pick<InstantLimits, 'goodwillPerPersonPerMonth' | 'pauseMinRuns' | 'pauseFailureRateBps'>;

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
 * Decides whether this job's ending as ours is given back. `limits` are read before the transaction opens. Run inside the transaction that writes the ending, after the person's give-back lock is
 * taken, so two jobs of one person ending together cannot both take the last give-back. A job that never started ran nothing: it is given back
 * (nothing was charged to give) and uses none of the bound.
 */
export async function judgeJobGiveBack(tx: Prisma.TransactionClient, limits: GiveBackLimits, job: { id: string; personId: string; startedAt: Date | null }, now: Date): Promise<GiveBackVerdict> {
  if (!job.startedAt) return { give: true };
  // The job delivered something outside its computer, or tried to and the outcome is not known yet (it may settle as done after the job is over, and a
  // give-back cannot be taken back): the work may be done, so none of it is given back, whatever happened to the machine afterwards
  if ((await tx.computerEffect.count({ where: { jobId: job.id, state: { in: ['done', 'planned'] } } })) > 0) return { give: false, why: 'outside_effect' };

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
