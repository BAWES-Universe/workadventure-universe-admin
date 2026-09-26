import { prisma } from '@/lib/db';
import { isPrivileged, viewerUserId, type Viewer } from '@/lib/access-scope';

/**
 * Where "Visit" takes someone for a universe or a world: the first room they can enter, decided on the server.
 *
 * - A place someone may see: public, or they own the universe, or they are a member of the world (or privileged).
 * - Not banned there (universe, world or global ban on their account).
 * - Worlds and rooms in creation order; the first one they may see wins.
 *
 * `no-access`: they may not see the universe or world, or are banned there. `no-room`: nothing to visit yet.
 */
export type LandingRoom =
  | { ok: true; roomUrl: string }
  | { ok: false; reason: 'not-found' | 'no-access' | 'no-room' };

export const LANDING_ROOM_MESSAGES: Record<'no-access' | 'no-room', string> = {
  'no-access': "You don't have access to a room here.",
  'no-room': 'There is no room to visit here yet.',
};

interface Place {
  universeId: string;
  universeSlug: string;
  universeOwnerId: string;
  universeIsPublic: boolean;
  worlds: {
    id: string;
    slug: string;
    isPublic: boolean;
    rooms: { slug: string; isPublic: boolean }[];
  }[];
}

async function bannedWorldIds(userId: string, worldIds: string[]): Promise<Set<string>> {
  if (worldIds.length === 0) return new Set();
  const bans = await prisma.ban.findMany({
    where: {
      isActive: true,
      userId,
      worldId: { in: worldIds },
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    },
    select: { worldId: true },
  });
  return new Set(bans.map((ban) => ban.worldId).filter((id): id is string => id !== null));
}

async function landingIn(viewer: Viewer, place: Place): Promise<LandingRoom> {
  const privileged = isPrivileged(viewer);
  const userId = viewerUserId(viewer);
  const isOwner = userId !== null && place.universeOwnerId === userId;

  const memberWorldIds = new Set<string>();
  if (userId !== null && place.worlds.length > 0) {
    const memberships = await prisma.worldMember.findMany({
      where: { userId, worldId: { in: place.worlds.map((world) => world.id) } },
      select: { worldId: true },
    });
    for (const membership of memberships) memberWorldIds.add(membership.worldId);
  }

  const mayEnterUniverse = privileged || isOwner || place.universeIsPublic || memberWorldIds.size > 0;
  if (!mayEnterUniverse) return { ok: false, reason: 'no-access' };

  if (userId !== null && !privileged) {
    // A universe-wide (or global) ban closes everything; a world ban closes that world only.
    const universeBan = await prisma.ban.findFirst({
      where: {
        isActive: true,
        userId,
        OR: [{ universeId: place.universeId, worldId: null }, { worldId: null, universeId: null }],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }],
      },
      select: { id: true },
    });
    if (universeBan) return { ok: false, reason: 'no-access' };
  }
  const closedWorlds = userId !== null && !privileged
    ? await bannedWorldIds(userId, place.worlds.map((world) => world.id))
    : new Set<string>();

  const visibleWorlds = place.worlds.filter(
    (world) =>
      !closedWorlds.has(world.id) && (privileged || isOwner || world.isPublic || memberWorldIds.has(world.id)),
  );
  if (visibleWorlds.length === 0) {
    return { ok: false, reason: place.worlds.length === 0 ? 'no-room' : 'no-access' };
  }

  for (const world of visibleWorlds) {
    const mayEnterPrivateRooms = privileged || isOwner || memberWorldIds.has(world.id);
    const room = world.rooms.find((candidate) => candidate.isPublic || mayEnterPrivateRooms);
    if (room) return { ok: true, roomUrl: `/@/${place.universeSlug}/${world.slug}/${room.slug}` };
  }
  return { ok: false, reason: 'no-room' };
}

const worldsWithRooms = {
  orderBy: { createdAt: 'asc' as const },
  select: {
    id: true,
    slug: true,
    isPublic: true,
    rooms: { orderBy: { createdAt: 'asc' as const }, select: { slug: true, isPublic: true } },
  },
};

export async function landingRoomForUniverse(viewer: Viewer, universeId: string): Promise<LandingRoom> {
  const universe = await prisma.universe.findUnique({
    where: { id: universeId },
    select: { id: true, slug: true, ownerId: true, isPublic: true, worlds: worldsWithRooms },
  });
  if (!universe) return { ok: false, reason: 'not-found' };
  return landingIn(viewer, {
    universeId: universe.id,
    universeSlug: universe.slug,
    universeOwnerId: universe.ownerId,
    universeIsPublic: universe.isPublic,
    worlds: universe.worlds,
  });
}

export async function landingRoomForWorld(viewer: Viewer, worldId: string): Promise<LandingRoom> {
  const world = await prisma.world.findUnique({
    where: { id: worldId },
    select: {
      id: true,
      slug: true,
      isPublic: true,
      rooms: worldsWithRooms.select.rooms,
      universe: { select: { id: true, slug: true, ownerId: true, isPublic: true } },
    },
  });
  if (!world) return { ok: false, reason: 'not-found' };
  return landingIn(viewer, {
    universeId: world.universe.id,
    universeSlug: world.universe.slug,
    universeOwnerId: world.universe.ownerId,
    // Visiting a world directly only needs the world to be visible, not the whole universe.
    universeIsPublic: world.universe.isPublic || world.isPublic,
    worlds: [{ id: world.id, slug: world.slug, isPublic: world.isPublic, rooms: world.rooms }],
  });
}
