import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';
import { withWokas } from '@/lib/woka-avatar';
import { NOT_SYSTEM_USER } from '@/lib/system-user';
import { canSeeWorld } from '@/lib/room-visibility';

const inviteMemberSchema = z.object({
  userId: z.string().uuid(),
  tags: z.array(z.string()).min(1),
  message: z.string().optional(),
});

const updateMemberSchema = z.object({
  tags: z.array(z.string()).min(1),
});

/** Highest role first, as the members list sorts them. */
const MEMBER_ORDER = ['owner', 'admin', 'editor', 'member'];

// Helper function to check if user can manage world members
async function canManageWorldMembers(worldId: string, userId: string): Promise<boolean> {
  const world = await prisma.world.findUnique({
    where: { id: worldId },
    include: {
      universe: {
        select: { ownerId: true },
      },
      members: {
        where: {
          userId: userId,
          tags: { has: 'admin' },
        },
      },
    },
  });

  if (!world) return false;

  // Check if user is universe owner
  if (world.universe.ownerId === userId) return true;

  // Check if user is world admin
  if (world.members.length > 0) return true;

  return false;
}

// GET /api/admin/worlds/[id]/members - List world members
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const world = await prisma.world.findUnique({
      where: { id },
      select: { id: true, isPublic: true, universe: { select: { name: true, isPublic: true, ownerId: true } } },
    });
    const isMember = !!world && !!(await prisma.worldMember.findUnique({
      where: { userId_worldId: { userId: sessionUser.id, worldId: id } },
      select: { id: true },
    }));
    // A world you can't see has no members you can see
    if (!world || !canSeeWorld(world, sessionUser, new Set(isMember ? [id] : []))) {
      return NextResponse.json({ error: 'World not found' }, { status: 404 });
    }

    // Anyone who can see the world sees its members; only the people who manage it see their emails
    const canManage = await canManageWorldMembers(id, sessionUser.id);
    const canSeeEmails = canManage || sessionUser.isSuperAdmin;

    // The System account is nobody, so it never shows as a member
    const everyone = await prisma.worldMember.findMany({
      where: { worldId: id, user: NOT_SYSTEM_USER },
      select: { id: true, userId: true, tags: true },
    });
    const total = everyone.length;
    const yourTags = everyone.find((member) => member.userId === sessionUser.id)?.tags ?? [];

    // `?limit=8` is the world page's row of faces: the first few by rank, with the total and your own roles, without
    // reading every visit of every member.
    const limitParam = Number.parseInt(request.nextUrl.searchParams.get('limit') ?? '', 10);
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 50) : null;
    let onlyIds: string[] | undefined;
    if (limit !== null) {
      const rankOf = (member: { userId: string; tags: string[] }) =>
        world.universe.ownerId === member.userId
          ? 0
          : Math.min(9, ...member.tags.map((tag) => MEMBER_ORDER.indexOf(tag.toLowerCase()) + 1 || 9));
      onlyIds = [...everyone].sort((a, b) => rankOf(a) - rankOf(b)).slice(0, limit).map((member) => member.id);
    }

    const members = await prisma.worldMember.findMany({
      where: { worldId: id, user: NOT_SYSTEM_USER, ...(onlyIds ? { id: { in: onlyIds } } : {}) },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });
    if (onlyIds) {
      const position = new Map(onlyIds.map((memberId, index) => [memberId, index]));
      members.sort((a, b) => (position.get(a.id) ?? 0) - (position.get(b.id) ?? 0));
    }

    // Get last visited dates from RoomAccess
    const userIds = members.map(m => m.userId);
    const lastVisits = onlyIds ? [] : await prisma.roomAccess.findMany({
      where: {
        worldId: id,
        userId: { in: userIds },
      },
      select: {
        userId: true,
        accessedAt: true,
      },
      orderBy: { accessedAt: 'desc' },
    });

    // Group by userId and get most recent
    const lastVisitMap = new Map<string, Date>();
    for (const visit of lastVisits) {
      if (visit.userId) {
        const existing = lastVisitMap.get(visit.userId);
        if (!existing || visit.accessedAt > existing) {
          lastVisitMap.set(visit.userId, visit.accessedAt);
        }
      }
    }

    const membersWithLastVisit = members.map(member => ({
      ...member,
      user: { ...member.user, email: canSeeEmails ? member.user.email : null },
      lastVisited: lastVisitMap.get(member.userId) || null,
      isUniverseOwner: world.universe.ownerId === member.userId,
    }));

    return NextResponse.json({ 
      members: await withWokas(membersWithLastVisit),
      canManage,
      total,
      yourTags,
      yourId: sessionUser.id,
      universeName: world.universe.name,
    });
  } catch (error) {
    console.error('Error fetching world members:', error);
    return NextResponse.json(
      { error: 'Failed to fetch members' },
      { status: 500 }
    );
  }
}

// POST /api/admin/worlds/[id]/members/invite - Invite user to world
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    const body = await request.json();

    // Check permissions
    const canManage = await canManageWorldMembers(id, sessionUser.id);
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const data = inviteMemberSchema.parse(body);

    // Check if world exists
    const world = await prisma.world.findUnique({
      where: { id },
    });

    if (!world) {
      return NextResponse.json({ error: 'World not found' }, { status: 404 });
    }

    // Check if user exists
    const user = await prisma.user.findUnique({
      where: { id: data.userId },
    });

    if (!user) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Check if user is already a member
    const existingMember = await prisma.worldMember.findUnique({
      where: {
        userId_worldId: {
          userId: data.userId,
          worldId: id,
        },
      },
    });

    if (existingMember) {
      return NextResponse.json(
        { error: 'User is already a member of this world' },
        { status: 400 }
      );
    }

    // Check if there's already a pending invitation
    const existingPendingInvitation = await prisma.membershipInvitation.findFirst({
      where: {
        worldId: id,
        invitedUserId: data.userId,
        status: 'pending',
      },
    });

    if (existingPendingInvitation) {
      return NextResponse.json(
        { error: 'User already has a pending invitation' },
        { status: 400 }
      );
    }

    // Check if there's a cancelled/rejected invitation that we should reactivate
    const existingNonPendingInvitation = await prisma.membershipInvitation.findFirst({
      where: {
        worldId: id,
        invitedUserId: data.userId,
        status: { in: ['cancelled', 'rejected'] },
      },
      orderBy: {
        invitedAt: 'desc',
      },
    });

    let invitation;
    if (existingNonPendingInvitation) {
      // Reactivate the invitation
      invitation = await prisma.membershipInvitation.update({
        where: { id: existingNonPendingInvitation.id },
        data: {
          status: 'pending',
          invitedByUserId: sessionUser.id,
          tags: data.tags,
          message: data.message || null,
          invitedAt: new Date(),
          respondedAt: null,
        },
        include: {
          invitedUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          invitedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          world: {
            select: {
              id: true,
              name: true,
              slug: true,
              universe: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                },
              },
            },
          },
        },
      });
    } else {
      // Create new invitation
      invitation = await prisma.membershipInvitation.create({
        data: {
          worldId: id,
          invitedUserId: data.userId,
          invitedByUserId: sessionUser.id,
          status: 'pending',
          tags: data.tags,
          message: data.message || null,
        },
        include: {
          invitedUser: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          invitedBy: {
            select: {
              id: true,
              name: true,
              email: true,
            },
          },
          world: {
            select: {
              id: true,
              name: true,
              slug: true,
              universe: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                },
              },
            },
          },
        },
      });
    }

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.issues },
        { status: 400 }
      );
    }
    // Handle Prisma unique constraint errors
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      return NextResponse.json(
        { error: 'User already has a pending invitation to this world' },
        { status: 400 }
      );
    }
    console.error('Error inviting member:', error);
    return NextResponse.json(
      { error: 'Failed to invite member' },
      { status: 500 }
    );
  }
}

