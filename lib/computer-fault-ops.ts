import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getInstantLimits } from '@/lib/instant/state';
import { INSTANT_LIMITS_RECOMMENDED, type InstantLimits } from '@/lib/instant/values';
import { OURS_REASONS } from '@/lib/computer-faults';
import { PROVIDER_REASONS, incidentFaultMatch, routeIsPaused } from '@/lib/computer-route-pause';

import { refundOverview, type RefundOverview } from '@/lib/computer-refunds';
import { correctDecisionForIncident, giveBackAfter, giveBackSettingsProblems, lockPerson, readGiveBackLimits } from '@/lib/computer-giveback';

// Where the route pause lives now (see lib/computer-route-pause); re-exported so operations code keeps one place to ask
export { routeIsPaused };

/**
 * One provider failing for many people is an incident, not many people's bad luck (the per-person bound cannot see it). Failures are counted by the route
 * they went to (the provider and route the relay names): the DIFFERENT PEOPLE who had a job with a provider failure of an unresolved kind, or our key
 * refused, on the route in Instant's failure window (one person's jobs are one: a person's own words can cause a 400 or a timeout, and one person alone
 * must never be able to pause a route for everyone). When that reaches Instant's own smallest batch (pauseMinRuns, the same numbers Instant pauses itself by)
 * new platform-funded work on that route is paused. Nothing is stored: it lifts by itself once the window passes with fewer, and the person's own key is never paused.
 * Operations see what is at risk and correct every affected job together.
 */

export interface GiveBackOverview {
  at: string;
  /** What is wrong with the settings the bound reads (empty when none). */
  settingsProblems: string[];
  /** Decisions by state and basis: how many jobs, and what their computer time and platform-paid model calls cost (millionths of a dollar). */
  decisions: Array<{ state: string; basis: string; jobs: number; costMicros: number }>;
  /** The money still charged to people provisionally while a decision waits, and the age of the oldest. */
  pending: { jobs: number; costMicros: number; oldestAt: string | null; oldestMinutes: number | null };
  /** Routes with provider failures in the window, and whether new work on them is paused. */
  routes: Array<{ route: string; failedPeople: number; paused: boolean }>;
  /** Refunds of credit a failed job drew that the books have not acknowledged: how many, how much, how old, and how many are overdue (the list is at /api/admin/computer/refund-obligations). */
  refunds: RefundOverview['owed'];
}

/** What operations see: the settings, the decisions with what each group cost, what is held, and the routes that are failing. Reads only. */
export async function giveBackOverview(now: Date = new Date()): Promise<GiveBackOverview> {
  const limits = await getInstantLimits();
  const decisions = await prisma.$queryRaw<Array<{ state: string; basis: string; jobs: number; cost: bigint }>>(Prisma.sql`
    SELECT d."state", d."basis", COUNT(*)::int AS jobs, COALESCE(SUM(c."cost"), 0)::bigint AS cost
    FROM "computer_give_back_decisions" d
    LEFT JOIN LATERAL (
      SELECT SUM(e."cost_micros") AS cost FROM "meter_events" e
      WHERE e."job_id" = d."job_id" AND e."pool" = 'computer' AND e."kind" IN ('computer_time', 'model_call') AND e."payer_kind" = 'universe'
    ) c ON TRUE
    GROUP BY d."state", d."basis" ORDER BY d."state", d."basis"`);
  const list = decisions.map((row) => ({ state: row.state, basis: row.basis, jobs: row.jobs, costMicros: Number(row.cost) }));
  const waiting = list.filter((row) => row.state === 'pending');
  const oldest = await prisma.computerGiveBackDecision.findFirst({ where: { state: 'pending' }, orderBy: { decidedAt: 'asc' }, select: { decidedAt: true } });
  const since = new Date(now.getTime() - limits.pauseWindowMinutes * 60 * 1000);
  const failing = await prisma.$queryRaw<Array<{ route: string; jobs: number }>>(Prisma.sql`
    SELECT f."route", COUNT(DISTINCT j."person_id")::int AS jobs FROM "computer_job_faults" f JOIN "computer_jobs" j ON j."id" = f."job_id"
    WHERE f."route" IS NOT NULL AND f."source" = 'universe-ai' AND f."kind" <> 'answered' AND f."at" >= ${since} AND f."reason" IN (${Prisma.join([...PROVIDER_REASONS])})
    GROUP BY f."route" ORDER BY jobs DESC LIMIT 50`);
  return {
    at: now.toISOString(),
    settingsProblems: giveBackSettingsProblems(limits),
    decisions: list,
    pending: {
      jobs: waiting.reduce((sum, row) => sum + row.jobs, 0),
      costMicros: waiting.reduce((sum, row) => sum + row.costMicros, 0),
      oldestAt: oldest?.decidedAt.toISOString() ?? null,
      oldestMinutes: oldest ? Math.floor((now.getTime() - oldest.decidedAt.getTime()) / 60_000) : null,
    },
    routes: failing.map((row) => ({ route: row.route, failedPeople: row.jobs, paused: limits.pauseMinRuns !== null && row.jobs >= limits.pauseMinRuns })),
    refunds: (await refundOverview(now)).owed,
  };
}

/**
 * Gives back every job that had a provider failure on a route between two times and is not a give-back yet (charged for the person's cap, for an effect still
 * to be confirmed, or held): one incident, corrected together. A job already given back as counted goodwill is UN-COUNTED (it was the provider's incident, not
 * the person's bad luck, so it no longer uses their bound). A job the person's own doing stopped (evidence of theirs) or that delivered something outside its
 * computer is left alone. None of these count towards anyone's bound. Safe to say twice. `corrected` is the jobs given back now; `uncounted` the goodwill ones
 * freed from the bound.
 */
export async function correctRouteTogether(input: { route: string; from: Date; to: Date }, batch = 500): Promise<{ corrected: number; uncounted: number; costMicros: number }> {
  let corrected = 0;
  let uncounted = 0;
  let costMicros = 0;
  // Every eligible job, a batch at a time in the order of their ids (a job the correction leaves as it is, or one it changes, is never read twice): an incident that
  // touched more jobs than one batch is corrected whole, not up to a limit nobody is told about
  let after = '';
  for (;;) {
    const candidates = await prisma.$queryRaw<Array<{ job_id: string; person_id: string }>>(Prisma.sql`
      SELECT DISTINCT d."job_id", d."person_id" FROM "computer_give_back_decisions" d
      JOIN "computer_job_faults" f ON f."job_id" = d."job_id"
      WHERE ${incidentFaultMatch(input.route, input.from, input.to, OURS_REASONS)}
        AND (d."state" = 'pending' OR (d."state" = 'refused' AND d."basis" IN ('cap', 'paused')) OR (d."state" = 'given' AND d."basis" = 'goodwill'))
        AND d."job_id" > ${after}
      ORDER BY d."job_id" ASC
      LIMIT ${batch}`);
    for (const one of candidates) {
      const job = { id: one.job_id, personId: one.person_id };
      const changed = await prisma.$transaction(async (tx) => {
        await lockPerson(tx, job.personId);
        return correctDecisionForIncident(tx, job, input);
      });
      if (!changed) continue;
      if (changed === 'uncounted') {
        uncounted++;
        continue;
      }
      await giveBackAfter(job);
      corrected++;
      const cost = await prisma.meterEvent.aggregate({ where: { jobId: job.id, pool: 'computer', kind: { in: ['computer_time', 'model_call'] }, payerKind: 'universe' }, _sum: { costMicros: true } });
      costMicros += Number(cost._sum.costMicros ?? 0);
    }
    if (candidates.length < batch) break;
    after = candidates[candidates.length - 1].job_id;
  }
  return { corrected, uncounted, costMicros };
}

/** Limits as they are now, for the readiness check (never throws). */
export async function giveBackReadiness(): Promise<{ ok: boolean; detail: string }> {
  const limits = await readGiveBackLimits();
  if (!limits) return { ok: false, detail: 'The limits the bound on computer give-backs reads could not be read' };
  const problems = giveBackSettingsProblems(limits);
  if (problems.length > 0) return { ok: false, detail: problems.join(' ') };
  const refunds = (await refundOverview()).owed;
  if (refunds.overdue > 0) return { ok: false, detail: `${refunds.overdue} refund${refunds.overdue === 1 ? '' : 's'} of credit a failed computer job drew ${refunds.overdue === 1 ? 'has' : 'have'} not been acknowledged by the books for over an hour (the oldest ${refunds.oldestMinutes} minutes): see /api/admin/computer/refund-obligations` };
  return { ok: true, detail: `Computer give-backs: bound of ${limits.goodwillPerPersonPerMonth && limits.goodwillPerPersonPerMonth >= 1 ? limits.goodwillPerPersonPerMonth : 'what Instant’s pause numbers allow'} a person a month for unresolved failures; confirmed faults of ours are always given back` };
}

export const RECOMMENDED_PAUSE_WINDOW_MINUTES = INSTANT_LIMITS_RECOMMENDED.pauseWindowMinutes;
