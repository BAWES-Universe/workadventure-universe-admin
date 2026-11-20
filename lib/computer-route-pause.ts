import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { getInstantLimits } from '@/lib/instant/state';
import type { InstantLimits } from '@/lib/instant/values';
import { UNRESOLVED_REASONS } from '@/lib/computer-faults';

/**
 * Whether a route is paused for new platform-funded work. Kept apart from lib/computer-fault-ops (which reads the give-back decisions and so imports
 * lib/computer-giveback, which imports lib/computer-calls) so the model-call authorizer can ask without pulling that cycle in: this module reads only
 * the database, Instant's limits and the fault reasons. The rule itself is described in lib/computer-fault-ops.
 */

/** The reasons that count towards a provider's failures: what a provider does (or refuses on our key), not what the relay or the person does. */
export const PROVIDER_REASONS: readonly string[] = [...UNRESOLVED_REASONS, 'provider_key_ours'];

type PauseLimits = Pick<InstantLimits, 'pauseMinRuns' | 'pauseWindowMinutes'>;

/** How many different PEOPLE had a job with a provider failure on this route inside the window ending now. */
export async function routeFailurePeople(route: string, now: Date, limits: Pick<InstantLimits, 'pauseWindowMinutes'>): Promise<number> {
  const since = new Date(now.getTime() - limits.pauseWindowMinutes * 60 * 1000);
  const rows = await prisma.$queryRaw<Array<{ jobs: number }>>(Prisma.sql`
    SELECT COUNT(DISTINCT j."person_id")::int AS jobs FROM "computer_job_faults" f JOIN "computer_jobs" j ON j."id" = f."job_id"
    WHERE f."route" = ${route} AND f."source" = 'universe-ai' AND f."kind" <> 'answered' AND f."at" >= ${since} AND f."reason" IN (${Prisma.join([...PROVIDER_REASONS])})`);
  return rows[0]?.jobs ?? 0;
}

/** Whether new platform-funded work on this route is paused now. Limits that cannot be read never pause work on a blip. */
export async function routeIsPaused(route: string, now: Date = new Date()): Promise<boolean> {
  const limits: PauseLimits & Partial<InstantLimits> = await getInstantLimits();
  if (limits.pauseMinRuns === null || limits.pauseMinRuns === undefined) return false;
  return (await routeFailurePeople(route, now, limits)) >= limits.pauseMinRuns;
}
