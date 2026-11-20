import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getInstantLimits } from '@/lib/instant/state';
import { INSTANT_LIMITS_RECOMMENDED, type InstantLimits } from '@/lib/instant/values';
import { OURS_REASONS, UNRESOLVED_REASONS } from '@/lib/computer-faults';
import { applyGiveBack, giveBackAfter, giveBackSettingsProblems, lockPerson, readGiveBackLimits } from '@/lib/computer-giveback';

/**
 * One provider failing for many people is an incident, not many people's bad luck (the per-person bound cannot see it). Failures are counted by the route
 * they went to (the provider and route the relay names): the jobs that had a provider failure of an unresolved kind, or our key refused, on the route in
 * Instant's failure window. When that reaches Instant's own smallest batch (pauseMinRuns, the same numbers Instant pauses itself by) new platform-funded
 * work on that route is paused. Nothing is stored: it lifts by itself once the window passes with fewer, and the person's own key is never paused.
 * Operations see what is at risk and correct every affected job together.
 */

/** The reasons that count towards a provider's failures: what a provider does (or refuses on our key), not what the relay or the person does. */
const PROVIDER_REASONS: readonly string[] = [...UNRESOLVED_REASONS, 'provider_key_ours'];

type PauseLimits = Pick<InstantLimits, 'pauseMinRuns' | 'pauseWindowMinutes'>;

/** How many different jobs had a provider failure on this route inside the window ending now. */
export async function routeFailureJobs(route: string, now: Date, limits: Pick<InstantLimits, 'pauseWindowMinutes'>): Promise<number> {
  const since = new Date(now.getTime() - limits.pauseWindowMinutes * 60 * 1000);
  const rows = await prisma.$queryRaw<Array<{ jobs: number }>>(Prisma.sql`
    SELECT COUNT(DISTINCT "job_id")::int AS jobs FROM "computer_job_faults"
    WHERE "route" = ${route} AND "source" = 'universe-ai' AND "kind" <> 'answered' AND "at" >= ${since} AND "reason" IN (${Prisma.join([...PROVIDER_REASONS])})`);
  return rows[0]?.jobs ?? 0;
}

/** Whether new platform-funded work on this route is paused now. Limits that cannot be read never pause work on a blip. */
export async function routeIsPaused(route: string, now: Date = new Date()): Promise<boolean> {
  const limits: PauseLimits & Partial<InstantLimits> = await getInstantLimits();
  if (limits.pauseMinRuns === null || limits.pauseMinRuns === undefined) return false;
  return (await routeFailureJobs(route, now, limits)) >= limits.pauseMinRuns;
}

export interface GiveBackOverview {
  at: string;
  /** What is wrong with the settings the bound reads (empty when none). */
  settingsProblems: string[];
  /** Decisions by state and basis: how many jobs, and what their computer time and platform-paid model calls cost (millionths of a dollar). */
  decisions: Array<{ state: string; basis: string; jobs: number; costMicros: number }>;
  /** The money still charged to people provisionally while a decision waits, and the age of the oldest. */
  pending: { jobs: number; costMicros: number; oldestAt: string | null; oldestMinutes: number | null };
  /** Routes with provider failures in the window, and whether new work on them is paused. */
  routes: Array<{ route: string; failedJobs: number; paused: boolean }>;
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
    SELECT "route", COUNT(DISTINCT "job_id")::int AS jobs FROM "computer_job_faults"
    WHERE "route" IS NOT NULL AND "source" = 'universe-ai' AND "kind" <> 'answered' AND "at" >= ${since} AND "reason" IN (${Prisma.join([...PROVIDER_REASONS])})
    GROUP BY "route" ORDER BY jobs DESC LIMIT 50`);
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
    routes: failing.map((row) => ({ route: row.route, failedJobs: row.jobs, paused: limits.pauseMinRuns !== null && row.jobs >= limits.pauseMinRuns })),
  };
}

/**
 * Gives back every job that had a provider failure on a route between two times and is not a give-back yet (charged for the person's cap, for an effect still
 * to be confirmed, or held): one incident, corrected together. A job the person's own doing stopped (evidence of theirs) or that delivered something outside its
 * computer is left alone. None of these count towards anyone's bound. Safe to say twice.
 */
export async function correctRouteTogether(input: { route: string; from: Date; to: Date }): Promise<{ corrected: number; costMicros: number }> {
  const candidates = await prisma.$queryRaw<Array<{ job_id: string; person_id: string }>>(Prisma.sql`
    SELECT DISTINCT d."job_id", d."person_id" FROM "computer_give_back_decisions" d
    JOIN "computer_job_faults" f ON f."job_id" = d."job_id"
    WHERE f."route" = ${input.route} AND f."at" >= ${input.from} AND f."at" <= ${input.to} AND f."source" = 'universe-ai' AND f."reason" IN (${Prisma.join([...PROVIDER_REASONS, ...OURS_REASONS])})
      AND (d."state" = 'pending' OR (d."state" = 'refused' AND d."basis" IN ('cap', 'paused')))
    LIMIT 500`);
  let corrected = 0;
  let costMicros = 0;
  for (const one of candidates) {
    const job = { id: one.job_id, personId: one.person_id };
    const changed = await prisma.$transaction(async (tx) => {
      await lockPerson(tx, job.personId);
      const flipped = await tx.computerGiveBackDecision.updateMany({
        where: { jobId: job.id, OR: [{ state: 'pending' }, { state: 'refused', basis: { in: ['cap', 'paused'] } }] },
        data: { state: 'given', basis: 'incident', route: input.route, nextAttemptAt: null, lastError: null },
      });
      if (flipped.count === 0) return false;
      await applyGiveBack(tx, job, false);
      return true;
    });
    if (!changed) continue;
    await giveBackAfter(job);
    corrected++;
    const cost = await prisma.meterEvent.aggregate({ where: { jobId: job.id, pool: 'computer', kind: { in: ['computer_time', 'model_call'] }, payerKind: 'universe' }, _sum: { costMicros: true } });
    costMicros += Number(cost._sum.costMicros ?? 0);
  }
  return { corrected, costMicros };
}

/** Limits as they are now, for the readiness check (never throws). */
export async function giveBackReadiness(): Promise<{ ok: boolean; detail: string }> {
  const limits = await readGiveBackLimits();
  if (!limits) return { ok: false, detail: 'The limits the bound on computer give-backs reads could not be read' };
  const problems = giveBackSettingsProblems(limits);
  if (problems.length > 0) return { ok: false, detail: problems.join(' ') };
  return { ok: true, detail: `Computer give-backs: bound of ${limits.goodwillPerPersonPerMonth && limits.goodwillPerPersonPerMonth >= 1 ? limits.goodwillPerPersonPerMonth : 'what Instant’s pause numbers allow'} a person a month for unresolved failures; confirmed faults of ours are always given back` };
}

export const RECOMMENDED_PAUSE_WINDOW_MINUTES = INSTANT_LIMITS_RECOMMENDED.pauseWindowMinutes;
