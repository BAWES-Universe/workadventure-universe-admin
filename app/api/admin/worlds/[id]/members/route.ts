import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';

const inviteMemberSchema = z.object({
  userId: z.string().uuid(),
  tags: z.array(z.string()).min(1),
  message: z.string().optional(),
});

const updateMemberSchema = z.object({
  tags: z.array(z.string()).min(1),
});

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

    // Check permissions for management (but allow viewing for anyone)
    const canManage = await canManageWorldMembers(id, sessionUser.id);

    const members = await prisma.worldMember.findMany({
      where: { worldId: id },
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

    // Get last visited dates from RoomAccess
    const userIds = members.map(m => m.userId);
    const lastVisits = await prisma.roomAccess.findMany({
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

    // Get universe owner info
    const world = await prisma.world.findUnique({
      where: { id },
      include: {
        universe: {
          select: { ownerId: true },
        },
      },
    });

    const membersWithLastVisit = members.map(member => ({
      ...member,
      lastVisited: lastVisitMap.get(member.userId) || null,
      isUniverseOwner: world?.universe.ownerId === member.userId,
    }));

    return NextResponse.json({ 
      members: membersWithLastVisit,
      canManage,
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

