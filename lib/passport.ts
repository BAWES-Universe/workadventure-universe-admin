import { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { SHARING_KEYS, sharePassportFromRows } from '@/lib/people-settings';

/**
 * Your passport: one stamp for every world you have been to, from the room visits Orbit already records. Someone
 * else sees only the stamps of public worlds in public universes; the owner sees all of them.
 */

export interface Stamp {
  worldId: string;
  world: string;
  universe: { id: string; name: string };
  visits: number;
  /** When they first came, an ISO date. */
  since: string;
}

export interface Passport {
  /** Most visited first. */
  stamps: Stamp[];
  worlds: number;
  universes: number;
  /** The first visit overall, an ISO date; null with no visits. */
  since: string | null;
  /** Days on which they went into a room. */
  days: number;
}

/** The stamps on the passport the card shows in the game. */
export const CARD_STAMPS = 3;
const MAX_STAMPS = 60;

const EMPTY: Passport = { stamps: [], worlds: 0, universes: 0, since: null, days: 0 };

/** Everything the owner has been to, or only what a stranger may see. */
export async function loadPassport(userId: string, options: { owner: boolean }): Promise<Passport> {
  const groups = await prisma.roomAccess.groupBy({
    by: ['worldId'],
    where: { userId },
    _count: { _all: true },
    _min: { accessedAt: true },
  });
  if (groups.length === 0) return EMPTY;

  const worlds = await prisma.world.findMany({
    where: { id: { in: groups.map((group) => group.worldId) } },
    select: { id: true, name: true, isPublic: true, universe: { select: { id: true, name: true, isPublic: true } } },
  });
  const byId = new Map(worlds.map((world) => [world.id, world]));

  const stamps: Stamp[] = [];
  for (const group of groups) {
    const world = byId.get(group.worldId);
    if (!world) continue;
    if (!options.owner && !(world.isPublic && world.universe.isPublic)) continue;
    stamps.push({
      worldId: world.id,
      world: world.name,
      universe: { id: world.universe.id, name: world.universe.name },
      visits: group._count._all,
      since: (group._min.accessedAt ?? new Date(0)).toISOString(),
    });
  }
  if (stamps.length === 0) return EMPTY;
  stamps.sort((a, b) => b.visits - a.visits || a.since.localeCompare(b.since) || a.world.localeCompare(b.world));

  // Someone else counts days only over the worlds they may see stamped, so days in private worlds stay private.
  const onlyShown = options.owner ? Prisma.empty : Prisma.sql` AND world_id IN (${Prisma.join(stamps.map((stamp) => stamp.worldId))})`;
  const rows = await prisma.$queryRaw<Array<{ days: bigint | number }>>`
    SELECT COUNT(DISTINCT DATE(accessed_at))::int AS days FROM room_accesses WHERE user_id = ${userId}${onlyShown}
  `;
  return {
    stamps: stamps.slice(0, MAX_STAMPS),
    worlds: stamps.length,
    universes: new Set(stamps.map((stamp) => stamp.universe.id)).size,
    since: stamps.reduce((first, stamp) => (stamp.since < first ? stamp.since : first), stamps[0].since),
    days: Number(rows[0]?.days ?? 0),
  };
}

/**
 * Whether `viewerId` (null when not signed in) may see `userId`'s passport: only if they show it to everyone, or to
 * friends and the viewer is one. Their own, a person always sees in full on You, not here.
 */
async function mayViewPassport(viewerId: string | null, userId: string): Promise<boolean> {
  const rows = await prisma.userPreference.findMany({
    where: { userId, key: { in: [...SHARING_KEYS] } },
    select: { key: true, value: true },
  });
  const audience = sharePassportFromRows(rows);
  if (audience === 'nobody') return false;
  if (audience === 'friends') {
    if (!viewerId) return false;
    if (viewerId !== userId) {
      const friendship = await prisma.friendship.findFirst({
        where: {
          status: 'accepted',
          OR: [
            { user1Id: viewerId, user2Id: userId },
            { user1Id: userId, user2Id: viewerId },
          ],
        },
        select: { id: true },
      });
      if (!friendship) return false;
    }
  }
  return true;
}

/**
 * The stamps `viewerId` (null when not signed in) may see on `userId`'s card: public worlds only, and only if they show
 * their passport to everyone, or to friends and the viewer is one. Their own, a person always sees in full on You, not here.
 */
export async function visibleStamps(viewerId: string | null, userId: string, limit: number): Promise<Stamp[]> {
  if (!(await mayViewPassport(viewerId, userId))) return [];
  return (await loadPassport(userId, { owner: false })).stamps.slice(0, limit);
}

/** The whole passport `viewerId` may see on someone's profile (public worlds only), or null when they hide it from this viewer. */
export async function visiblePassport(viewerId: string | null, userId: string): Promise<Passport | null> {
  if (!(await mayViewPassport(viewerId, userId))) return null;
  return loadPassport(userId, { owner: false });
}
