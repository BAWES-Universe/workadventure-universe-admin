import { prisma } from '@/lib/db';

/**
 * Your activity: what happened to you, newest first, from what Orbit already records: invitations, memberships,
 * stars, and the universes and worlds you made. Only you see it.
 */

export type ActivityKind = 'world' | 'star' | 'universe';

export interface ActivityEvent {
  id: string;
  kind: ActivityKind;
  text: string;
  /** An ISO date. */
  at: string;
  /** Where the event leads, when it leads anywhere. */
  href: string | null;
}

const PER_SOURCE = 20;
export const MAX_EVENTS = 8;

function role(tags: string[] | null): string {
  tags ??= [];
  if (tags.includes('admin')) return 'an admin';
  if (tags.includes('editor')) return 'an editor';
  return 'a member';
}

export async function loadActivity(userId: string): Promise<ActivityEvent[]> {
  const [invitations, memberships, stars, universes, worlds] = await Promise.all([
    prisma.membershipInvitation.findMany({
      where: { invitedUserId: userId },
      orderBy: { invitedAt: 'desc' },
      take: PER_SOURCE,
      select: { id: true, invitedAt: true, tags: true, world: { select: { id: true, name: true } }, invitedBy: { select: { name: true } } },
    }),
    prisma.worldMember.findMany({
      where: { userId },
      orderBy: { joinedAt: 'desc' },
      take: PER_SOURCE,
      select: { id: true, joinedAt: true, world: { select: { id: true, name: true, universe: { select: { name: true } } } } },
    }),
    prisma.favorite.findMany({
      where: { userId },
      orderBy: { favoritedAt: 'desc' },
      take: PER_SOURCE,
      select: {
        id: true,
        favoritedAt: true,
        universe: { select: { id: true, name: true } },
        world: { select: { id: true, name: true } },
        room: { select: { id: true, name: true } },
      },
    }),
    prisma.universe.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
      take: PER_SOURCE,
      select: { id: true, name: true, createdAt: true },
    }),
    prisma.world.findMany({
      where: { universe: { ownerId: userId } },
      orderBy: { createdAt: 'desc' },
      take: PER_SOURCE,
      select: { id: true, name: true, createdAt: true, universe: { select: { name: true } } },
    }),
  ]);

  const events: ActivityEvent[] = [];
  for (const invitation of invitations) {
    events.push({
      id: `invite-${invitation.id}`,
      kind: 'world',
      text: `${invitation.invitedBy.name?.trim() || 'Someone'} invited you to ${invitation.world.name} as ${role(invitation.tags)}`,
      at: invitation.invitedAt.toISOString(),
      href: `/admin/invitations/${invitation.id}`,
    });
  }
  for (const membership of memberships) {
    events.push({
      id: `member-${membership.id}`,
      kind: 'world',
      text: `You became a member of ${membership.world.name} in ${membership.world.universe.name}`,
      at: membership.joinedAt.toISOString(),
      href: `/admin/worlds/${membership.world.id}`,
    });
  }
  for (const star of stars) {
    const target = star.room
      ? { name: star.room.name, href: `/admin/rooms/${star.room.id}` }
      : star.world
        ? { name: star.world.name, href: `/admin/worlds/${star.world.id}` }
        : star.universe
          ? { name: star.universe.name, href: `/admin/universes/${star.universe.id}` }
          : null;
    if (!target) continue;
    events.push({ id: `star-${star.id}`, kind: 'star', text: `You starred ${target.name}`, at: star.favoritedAt.toISOString(), href: target.href });
  }
  for (const universe of universes) {
    events.push({
      id: `universe-${universe.id}`,
      kind: 'universe',
      text: `You made the universe ${universe.name}`,
      at: universe.createdAt.toISOString(),
      href: `/admin/universes/${universe.id}`,
    });
  }
  for (const world of worlds) {
    events.push({
      id: `world-${world.id}`,
      kind: 'world',
      text: `You made the world ${world.name} in ${world.universe.name}`,
      at: world.createdAt.toISOString(),
      href: `/admin/worlds/${world.id}`,
    });
  }
  return events.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_EVENTS);
}
