import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { wokaLayersForMany } from '@/lib/woka-avatar';

/** How many members the invitation shows, highest role first. */
const MEMBERS_SHOWN = 24;
/** Highest role first; the universe's owner, when a member, comes before everyone. */
const RANK = ['owner', 'admin', 'editor', 'member'];

const MEMBER_SELECT = {
  tags: true,
  user: { select: { id: true, name: true, visitCard: { select: { bio: true, links: true } } } },
} as const;

function rank(tags: string[]): number {
  const found = RANK.findIndex((role) => tags.some((tag) => tag.toLowerCase() === role));
  return found === -1 ? RANK.length : found;
}

/**
 * Up to MEMBERS_SHOWN of a world's members, owner, admins and editors before the rest (each group by who joined
 * first), with what their visit card says. Staff are asked for on their own, so a big world still shows them.
 */
async function membersByRank(worldId: string, ownerId: string) {
  const [staff, owner, earliest] = await Promise.all([
    prisma.worldMember.findMany({
      where: { worldId, tags: { hasSome: ['admin', 'editor', 'Admin', 'Editor'] } },
      select: MEMBER_SELECT,
      orderBy: { joinedAt: 'asc' },
      take: MEMBERS_SHOWN,
    }),
    prisma.worldMember.findFirst({ where: { worldId, userId: ownerId }, select: MEMBER_SELECT }),
    prisma.worldMember.findMany({ where: { worldId }, select: MEMBER_SELECT, orderBy: { joinedAt: 'asc' }, take: MEMBERS_SHOWN }),
  ]);
  const seen = new Set<string>();
  return [...(owner ? [owner] : []), ...staff, ...earliest]
    .filter((member) => !seen.has(member.user.id) && seen.add(member.user.id))
    .map((member, order) => ({
      member,
      order,
      tags: member.user.id === ownerId ? ['owner', ...member.tags] : member.tags,
    }))
    .sort((a, b) => rank(a.tags) - rank(b.tags) || a.order - b.order)
    .slice(0, MEMBERS_SHOWN)
    .map(({ member, tags }) => ({
      id: member.user.id,
      name: member.user.name,
      tags,
      bio: member.user.visitCard?.bio?.trim() || null,
      // Web links only, so an old javascript: or data: address never runs for whoever opens the card.
      links: ((member.user.visitCard?.links ?? []) as Array<{ label?: unknown; url?: unknown }>)
        .filter((link): link is { label: string; url: string } =>
          typeof link?.label === 'string' && typeof link?.url === 'string' && /^https?:\/\//i.test(link.url))
        .slice(0, 3)
        .map(({ label, url }) => ({ label, url })),
    }));
}

/**
 * GET /api/memberships/invitations/[id] - One invitation, for the person it was sent to.
 *
 * Only the invitee may read it; anyone else gets the same 404 as a missing invitation, so its existence isn't
 * revealed. It says what the invitation lets them see: who invited them, the world (with its first room, to visit
 * once they've joined) and a few of its members. No emails.
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const invitation = await prisma.membershipInvitation.findUnique({
      where: { id },
      select: {
        id: true,
        invitedUserId: true,
        status: true,
        tags: true,
        message: true,
        invitedAt: true,
        respondedAt: true,
        invitedBy: { select: { id: true, name: true } },
        world: {
          select: {
            id: true,
            name: true,
            slug: true,
            description: true,
            isPublic: true,
            thumbnailUrl: true,
            universe: { select: { id: true, name: true, slug: true, ownerId: true } },
            _count: { select: { rooms: true, members: true } },
            rooms: { select: { slug: true, name: true }, orderBy: { createdAt: 'asc' }, take: 1 },
          },
        },
      },
    });

    if (!invitation || invitation.invitedUserId !== sessionUser.id) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    const { world } = invitation;
    const people = await membersByRank(world.id, world.universe.ownerId);
    const wokas = await wokaLayersForMany([invitation.invitedBy.id, ...people.map((person) => person.id)]).catch(
      () => new Map<string, string[]>(),
    );

    return NextResponse.json({
      invitation: {
        id: invitation.id,
        status: invitation.status,
        tags: invitation.tags,
        message: invitation.message,
        invitedAt: invitation.invitedAt,
        respondedAt: invitation.respondedAt,
        invitedBy: {
          id: invitation.invitedBy.id,
          name: invitation.invitedBy.name,
          woka: wokas.get(invitation.invitedBy.id) ?? [],
        },
        world: {
          id: world.id,
          name: world.name,
          slug: world.slug,
          description: world.description,
          isPublic: world.isPublic,
          thumbnailUrl: world.thumbnailUrl,
          universe: { id: world.universe.id, name: world.universe.name, slug: world.universe.slug },
          counts: { rooms: world._count.rooms, members: world._count.members },
          firstRoom: world.rooms[0] ? { slug: world.rooms[0].slug, name: world.rooms[0].name } : null,
          members: people.map((person) => ({ ...person, woka: wokas.get(person.id) ?? [] })),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching invitation:', error);
    return NextResponse.json({ error: 'Failed to fetch invitation' }, { status: 500 });
  }
}
