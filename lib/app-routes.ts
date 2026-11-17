import { prisma } from '@/lib/db';
import { readReadyMadeApps } from '@/lib/app-adapter/settings';
import { ownVersionFor, whyNotReady, type OwnAppVersion } from '@/lib/app-routes/own-versions';

/**
 * Where an App runs (spec "Paying for Apps", section 21): `composio`, or `universe` (our own version). Every App runs on
 * Composio until a super admin moves it, and an App can move only when our own version has passed its checks.
 *
 * What a move changes is what a run costs us. It changes nothing a person sees: not the App's name, the price or the credit it
 * takes, the receipt or the permissions (those are read where they always were, never from here). A move applies to runs that
 * START after it; a run already going finishes where it started, because each run reads the route once, at its start.
 */

export const APP_ROUTES = ['composio', 'universe'] as const;
export type AppRouteName = (typeof APP_ROUTES)[number];

export interface RouteState {
  route: AppRouteName;
  /** 0 for an App never moved. Counts changes, so a save made on an older view is refused. */
  version: number;
  changedAt: Date | null;
}

export const KEY = /^[a-z0-9][a-z0-9_-]{0,59}$/;

export async function readRoute(appKey: string, db: Pick<typeof prisma, 'appRoute'> = prisma): Promise<RouteState> {
  const row = await db.appRoute.findUnique({ where: { appKey } });
  if (!row) return { route: 'composio', version: 0, changedAt: null };
  return { route: row.route === 'universe' ? 'universe' : 'composio', version: row.version, changedAt: row.changedAt };
}

export type RunRoute = { provider: 'composio' } | { provider: 'universe'; own: OwnAppVersion } | { provider: 'universe'; own: null };

/**
 * The route for a run that is starting. `own: null` on the universe route means our version is not there or not ready (it was
 * moved here and then withdrawn): the caller refuses the run. It never quietly runs on Composio, which could bill a second time.
 */
export async function routeForRun(appKey: string): Promise<RunRoute> {
  const state = await readRoute(appKey);
  if (state.route === 'composio') return { provider: 'composio' };
  const own = ownVersionFor(appKey);
  return { provider: 'universe', own: own && whyNotReady(appKey).length === 0 ? own : null };
}

export type SaveRouteOutcome =
  | { status: 'saved'; state: RouteState }
  | { status: 'unknown_app' }
  | { status: 'not_ready'; why: string[] }
  | { status: 'stale'; state: RouteState };

/**
 * Moves an App (super admin). `expectedVersion` is the version the admin was looking at: if someone else moved it since, nothing
 * changes and the newer state comes back. Moving to `composio` is always allowed (one step, no checks); moving to `universe` needs
 * our version to be there and to have passed its checks. Saving the route an App already has changes nothing.
 */
export async function saveRoute(input: { appKey: string; route: AppRouteName; expectedVersion: number; userId: string }): Promise<SaveRouteOutcome> {
  if (!KEY.test(input.appKey)) return { status: 'unknown_app' };
  // An App must be on the list to be moved to our own version. Moving one BACK to Composio is always allowed when it has a route of
  // its own, even if the App has since left the list: otherwise a route left on `universe` could never be undone.
  const known = (await readReadyMadeApps()).some((app) => app.key === input.appKey);
  if (!known && (input.route === 'universe' || (await readRoute(input.appKey)).version === 0)) return { status: 'unknown_app' };
  if (input.route === 'universe') {
    const why = whyNotReady(input.appKey);
    if (why.length > 0) return { status: 'not_ready', why };
  }
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`app-route:${input.appKey}`}, 0))`;
    const current = await readRoute(input.appKey, tx);
    if (current.version !== input.expectedVersion) return { status: 'stale' as const, state: current };
    if (current.route === input.route) return { status: 'saved' as const, state: current };
    const row = await tx.appRoute.upsert({
      where: { appKey: input.appKey },
      create: { appKey: input.appKey, route: input.route, version: 1, changedById: input.userId },
      update: { route: input.route, version: { increment: 1 }, changedAt: new Date(), changedById: input.userId },
    });
    return { status: 'saved' as const, state: { route: row.route === 'universe' ? ('universe' as const) : ('composio' as const), version: row.version, changedAt: row.changedAt } };
  });
}
