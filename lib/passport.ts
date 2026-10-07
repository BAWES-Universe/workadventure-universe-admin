import { prisma } from '@/lib/db';

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

  const rows = await prisma.$queryRaw<Array<{ days: bigint | number }>>`
    SELECT COUNT(DISTINCT DATE(accessed_at))::int AS days FROM room_accesses WHERE user_id = ${userId}
  `;
  return {
    stamps: stamps.slice(0, MAX_STAMPS),
    worlds: stamps.length,
    universes: new Set(stamps.map((stamp) => stamp.universe.id)).size,
    since: stamps.reduce((first, stamp) => (stamp.since < first ? stamp.since : first), stamps[0].since),
    days: Number(rows[0]?.days ?? 0),
  };
}
