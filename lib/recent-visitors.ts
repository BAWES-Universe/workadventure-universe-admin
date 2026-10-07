import { prisma } from '@/lib/db';
import { accessDetailFor, viewerUserId, type AccessScope, type Viewer } from '@/lib/access-scope';
import { withWokas } from '@/lib/woka-avatar';

/**
 * Recent visitors: the people who came by a universe, world or room lately, newest first, each once. Past visits, not
 * who is online. Only people who manage the place see who they were, as on the Visitors list; for anyone else there is
 * nothing to show (not a row of strangers).
 */

export interface RecentVisitor {
  userId: string;
  name: string;
  woka: string[];
  /** When they last came, an ISO date. */
  at: string;
  room: { id: string; name: string };
}

/** The faces in the row. */
export const RECENT_VISITORS = 8;
/** Enough visits to find that many different people. */
const LOOK_BACK = 200;

export async function loadRecentVisitors(viewer: Viewer, scope: AccessScope): Promise<RecentVisitor[]> {
  if ((await accessDetailFor(viewer, scope)) === 'minimal') return [];
  const me = viewerUserId(viewer);
  const visits = await prisma.roomAccess.findMany({
    where: { ...scope, userId: me ? { not: me } : { not: null } },
    orderBy: { accessedAt: 'desc' },
    take: LOOK_BACK,
    select: {
      userId: true,
      userName: true,
      accessedAt: true,
      room: { select: { id: true, name: true } },
      user: { select: { name: true, isGuest: true } },
    },
  });
  const seen = new Set<string>();
  const latest: typeof visits = [];
  for (const visit of visits) {
    if (!visit.userId || seen.has(visit.userId) || visit.user?.isGuest) continue;
    seen.add(visit.userId);
    latest.push(visit);
    if (latest.length === RECENT_VISITORS) break;
  }
  const withFaces = await withWokas(latest.map((visit) => ({ userId: visit.userId })));
  return latest.map((visit, index) => ({
    userId: visit.userId as string,
    name: visit.user?.name?.trim() || visit.userName?.trim() || 'Someone',
    woka: withFaces[index].woka ?? [],
    at: visit.accessedAt.toISOString(),
    room: { id: visit.room.id, name: visit.room.name },
  }));
}
