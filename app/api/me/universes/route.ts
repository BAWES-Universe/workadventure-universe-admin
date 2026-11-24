import { NextRequest } from 'next/server';
import { myUniverses } from '@/lib/app-sharing';
import { prisma } from '@/lib/db';
import { appsRoute, preflight } from '@/lib/me-apps-route';

export const runtime = 'nodejs';

const METHODS = 'GET, OPTIONS';

export async function OPTIONS(request: NextRequest) {
  return preflight(request, METHODS);
}

/**
 * GET /api/me/universes - "Your universes" at the bottom of Apps (game #2001): the universes where the caller can manage bots, each
 * with how many apps belong to it. Empty for anyone who manages no bots anywhere, so the section does not show.
 */
export async function GET(request: NextRequest) {
  return appsRoute(request, METHODS, 'listing universes for apps', async (user, respond) => {
    const universes = await myUniverses(user.id);
    const counts = await prisma.appConnection.groupBy({ by: ['universeId'], where: { universeId: { in: universes.map((universe) => universe.id) } }, _count: { _all: true } });
    const byUniverse = new Map(counts.map((row) => [row.universeId, row._count._all]));
    return respond({ universes: universes.map((universe) => ({ id: universe.id, name: universe.name, apps: byUniverse.get(universe.id) ?? 0 })) });
  });
}
