import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { wokaLayersForMany } from '@/lib/woka-avatar';

/** How many members' Wokas the invitation shows. */
const MEMBERS_SHOWN = 8;

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
            universe: { select: { id: true, name: true, slug: true } },
            _count: { select: { rooms: true, members: true } },
            rooms: { select: { slug: true, name: true }, orderBy: { createdAt: 'asc' }, take: 1 },
            members: {
              select: { user: { select: { id: true, name: true } } },
              orderBy: { joinedAt: 'asc' },
              take: MEMBERS_SHOWN,
            },
          },
        },
      },
    });

    if (!invitation || invitation.invitedUserId !== sessionUser.id) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    const { world } = invitation;
    const people = world.members.map((member) => member.user);
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
          universe: world.universe,
          counts: { rooms: world._count.rooms, members: world._count.members },
          firstRoom: world.rooms[0] ? { slug: world.rooms[0].slug, name: world.rooms[0].name } : null,
          members: people.map((person) => ({ id: person.id, name: person.name, woka: wokas.get(person.id) ?? [] })),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching invitation:', error);
    return NextResponse.json({ error: 'Failed to fetch invitation' }, { status: 500 });
  }
}
