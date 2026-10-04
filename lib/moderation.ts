import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { buildPlayUri } from '@/lib/utils';
import { canManageWorldMembers } from '@/lib/access-scope';

/**
 * Self-moderation: each world's admins and its universe's owner handle reports and bans for that world.
 * Super admins are not sent anyone's reports.
 */

/** How long an admin can ban someone for, picked in Orbit's ban dialog. */
export const BAN_DURATIONS = { '1d': 1, '7d': 7, forever: null } as const;
export type BanDuration = keyof typeof BAN_DURATIONS;

/** When a ban of the given duration, starting now, ends; null for one that never ends. */
export function banEndsAt(duration: BanDuration, now = new Date()): Date | null {
  const days = BAN_DURATIONS[duration];
  return days === null ? null : new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
}

/**
 * The bans that keep someone out of a world: a ban from that world, a ban from its whole universe, or a ban from
 * everywhere. A ban from one world never reaches the universe's other worlds.
 */
export function bansCoveringWorld(world: { id: string; universeId: string }): Prisma.BanWhereInput {
  return {
    isActive: true,
    AND: [
      {
        OR: [
          { worldId: world.id },
          { worldId: null, universeId: world.universeId },
          { worldId: null, universeId: null },
        ],
      },
      { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    ],
  };
}

/** The world a play address (`/@/universe/world/room`, with or without a host) points at, with its room. */
export function parseWorldAddress(playUri: string): { universe: string; world: string; room: string } | null {
  try {
    const url = new URL(playUri, 'http://play.invalid');
    const [at, universe, world, room] = url.pathname.split('/').filter(Boolean);
    if (at !== '@' || !universe || !world) return null;
    return { universe, world, room: room ?? '' };
  } catch {
    return null;
  }
}

/** A user as the game names them: their WorkAdventure uuid, or their email for signed-in players. */
export function findUserByIdentifier(identifier: string) {
  return prisma.user.findFirst({ where: { OR: [{ uuid: identifier }, { email: identifier }] } });
}

/**
 * Sends a player who was just banned out of every room of the world they're in, through the game's admin
 * endpoint. Without PLAY_URL or ADMIN_API_TOKEN, or when the game can't be reached, the ban still applies the
 * next time they try to enter.
 */
export async function sendOutOfWorld(userUuid: string, worldId: string): Promise<boolean> {
  const playUrl = process.env.PLAY_URL;
  const token = process.env.ADMIN_API_TOKEN;
  if (!playUrl || !token) return false;

  const world = await prisma.world.findUnique({
    where: { id: worldId },
    select: { slug: true, universe: { select: { slug: true } }, rooms: { select: { slug: true } } },
  });
  if (!world || world.rooms.length === 0) return false;

  const roomIds = world.rooms.map((room) => buildPlayUri(playUrl, world.universe.slug, world.slug, room.slug));
  try {
    const response = await fetch(new URL('/user/ban-kick', playUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({ userUuid, roomIds }),
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch (error) {
    console.error('Could not send a banned player out of their world:', error);
    return false;
  }
}

/** The longest appeal a banned player can send. */
export const MAX_APPEAL = 1000;

/**
 * A player's current ban from the world a play address points at (ban from the world itself first), with the
 * world. `ban` is null when nothing keeps them out.
 */
export async function findPlayerBan(identifier: string, playUri: string) {
  const address = parseWorldAddress(playUri);
  if (!address) return null;
  const world = await prisma.world.findFirst({
    where: { slug: address.world, universe: { slug: address.universe } },
    select: { id: true, name: true, universeId: true },
  });
  if (!world) return null;
  const user = await findUserByIdentifier(identifier);
  if (!user) return { world, user: null, ban: null };
  const ban = await prisma.ban.findFirst({
    where: { AND: [bansCoveringWorld(world), { userId: user.id }] },
    orderBy: [{ worldId: { sort: 'asc', nulls: 'last' } }, { bannedAt: 'desc' }],
  });
  return { world, user, ban };
}

/**
 * Who may see and act on a world's reports and bans: the universe's owner and the world's admins (the people who
 * manage its members), and super admins when they open the world themselves.
 */
export async function canModerateWorld(user: { id: string; isSuperAdmin?: boolean }, worldId: string): Promise<boolean> {
  if (user.isSuperAdmin) {
    return (await prisma.world.count({ where: { id: worldId } })) > 0;
  }
  return canManageWorldMembers(user.id, worldId);
}

/** The worlds whose reports reach this person: worlds in universes they own, and worlds they're an admin of. */
export function worldsModeratedBy(userId: string): Prisma.WorldWhereInput {
  return {
    OR: [{ universe: { ownerId: userId } }, { members: { some: { userId, tags: { has: 'admin' } } } }],
  };
}

/**
 * Names for players as Orbit knows them: their Orbit name, else the name they last used in this world, else
 * "Guest".
 */
export async function playerNames(worldId: string, people: { userId: string | null; uuid: string }[]) {
  const userIds = [...new Set(people.map((person) => person.userId).filter((id): id is string => !!id))];
  const uuids = [...new Set(people.map((person) => person.uuid))];
  const [users, visits] = await Promise.all([
    userIds.length
      ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, isGuest: true } })
      : [],
    uuids.length
      ? prisma.roomAccess.findMany({
          where: { worldId, userUuid: { in: uuids }, userName: { not: null } },
          orderBy: { accessedAt: 'desc' },
          distinct: ['userUuid'],
          select: { userUuid: true, userName: true },
        })
      : [],
  ]);
  const byUser = new Map(users.map((user) => [user.id, user]));
  const byUuid = new Map(visits.map((visit) => [visit.userUuid, visit.userName]));
  return (person: { userId: string | null; uuid: string }) => {
    const user = person.userId ? byUser.get(person.userId) : undefined;
    return {
      name: user?.name || byUuid.get(person.uuid) || 'Guest',
      isGuest: user ? user.isGuest : true,
    };
  };
}
