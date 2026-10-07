import { prisma } from '@/lib/db';
import { accessDetailFor, viewerUserId, type AccessScope, type Viewer } from '@/lib/access-scope';
import { withWokas } from '@/lib/woka-avatar';

/**
 * Recent visitors: the people who came by a universe, world or room lately, newest first, each once. Past visits, not
 * who is online. Only people who manage the place see who they were, as on the Visitors list; for anyone else there is
 * nothing to show (not a row of strangers).
 */

export interface RecentVisitor {
  /** One per person: their account id, or for a guest the id their browser keeps. */
  key: string;
  /** Their account, or null for a guest (no profile to open). */
  userId: string | null;
  /** Someone without an account, shown by the name they typed and the Woka they picked. */
  guest: boolean;
  name: string;
  woka: string[];
  /** When they last came, an ISO date. */
  at: string;
  room: { id: string; name: string };
}

/** How far back the guest count looks. */
export const GUEST_DAYS = 7;

/** The faces in the row. */
export const RECENT_VISITORS = 8;
/** Enough visits to find that many different people. */
const LOOK_BACK = 200;

/** The people with an account who came by, newest first, each once. */
async function memberVisits(viewer: Viewer, scope: AccessScope) {
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
  return latest;
}

/**
 * The guests who came by under a name they typed, newest first, each once (by the id their browser keeps). A guest's
 * name and outfit come from the visit that has them; visits from before they were saved have neither, so those guests
 * stay out of the row (they still count in the Guests chip).
 */
async function guestVisits(scope: AccessScope) {
  const visits = await prisma.roomAccess.findMany({
    where: { ...scope, userUuid: { not: null }, userName: { not: null }, OR: [{ userId: null }, { user: { isGuest: true } }] },
    orderBy: { accessedAt: 'desc' },
    take: LOOK_BACK,
    select: {
      userUuid: true,
      userName: true,
      textureIds: true,
      accessedAt: true,
      room: { select: { id: true, name: true } },
    },
  });
  const byGuest = new Map<string, { name: string; textureIds: string[]; at: Date; room: { id: string; name: string } }>();
  for (const visit of visits) {
    const uuid = visit.userUuid as string;
    const name = visit.userName?.trim();
    if (!name || name === uuid) continue;
    const known = byGuest.get(uuid);
    if (known) {
      if (known.textureIds.length === 0 && visit.textureIds.length > 0) known.textureIds = visit.textureIds;
      continue;
    }
    if (byGuest.size === RECENT_VISITORS) continue;
    byGuest.set(uuid, { name, textureIds: visit.textureIds, at: visit.accessedAt, room: { id: visit.room.id, name: visit.room.name } });
  }
  return [...byGuest.entries()].map(([uuid, guest]) => ({ uuid, ...guest }));
}

export async function loadRecentVisitors(viewer: Viewer, scope: AccessScope): Promise<RecentVisitor[]> {
  if ((await accessDetailFor(viewer, scope)) === 'minimal') return [];
  const [members, guests] = await Promise.all([memberVisits(viewer, scope), guestVisits(scope)]);
  const people = [
    ...members.map((visit) => ({
      key: visit.userId as string,
      userId: visit.userId as string,
      guest: false,
      name: visit.user?.name?.trim() || visit.userName?.trim() || 'Someone',
      at: visit.accessedAt,
      room: { id: visit.room.id, name: visit.room.name },
      face: { userId: visit.userId as string } as { userId: string | null; userUuid?: string; isGuest?: boolean; textureIds?: string[] },
    })),
    ...guests.map((guest) => ({
      key: guest.uuid,
      userId: null as string | null,
      guest: true,
      name: guest.name,
      at: guest.at,
      room: guest.room,
      face: { userId: null, userUuid: guest.uuid, isGuest: true, textureIds: guest.textureIds },
    })),
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, RECENT_VISITORS);
  const withFaces = await withWokas(people.map((person) => person.face));
  return people.map((person, index) => ({
    key: person.key,
    userId: person.userId,
    guest: person.guest,
    name: person.name,
    woka: withFaces[index].woka ?? [],
    at: person.at.toISOString(),
    room: person.room,
  }));
}

/**
 * How many different guests (people without an account) came by in the last week, for the "Guests" chip. A guest is
 * counted once however often they came back; a guest is told apart by their browser id, so someone on a new device
 * counts again. Only for people who manage the place, like the faces; 0 for anyone else.
 */
export async function loadGuestsThisWeek(viewer: Viewer, scope: AccessScope): Promise<number> {
  if ((await accessDetailFor(viewer, scope)) === 'minimal') return 0;
  const since = new Date(Date.now() - GUEST_DAYS * 24 * 60 * 60 * 1000);
  const guests = await prisma.roomAccess.groupBy({
    by: ['userUuid'],
    where: {
      ...scope,
      accessedAt: { gte: since },
      userUuid: { not: null },
      OR: [{ userId: null }, { user: { isGuest: true } }],
    },
  });
  return guests.length;
}
