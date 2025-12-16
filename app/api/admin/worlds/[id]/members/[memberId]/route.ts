import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';

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

// PATCH /api/admin/worlds/[id]/members/[memberId] - Update member tags
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: worldId, memberId } = await params;
    const body = await request.json();

    // Check permissions
    const canManage = await canManageWorldMembers(worldId, sessionUser.id);
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const data = updateMemberSchema.parse(body);

    // Check if member exists
    const member = await prisma.worldMember.findUnique({
      where: { id: memberId },
      include: {
        world: {
          include: {
            universe: {
              select: { ownerId: true },
            },
          },
        },
      },
    });

    if (!member) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // Check if member belongs to this world
    if (member.worldId !== worldId) {
      return NextResponse.json({ error: 'Member does not belong to this world' }, { status: 400 });
    }

    // Prevent removing universe owner
    if (member.world.universe.ownerId === member.userId) {
      return NextResponse.json(
        { error: 'Cannot modify universe owner membership' },
        { status: 403 }
      );
    }

    // Update member tags
    const updated = await prisma.worldMember.update({
      where: { id: memberId },
      data: {
        tags: data.tags,
      },
      include: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return NextResponse.json({ member: updated });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.issues },
        { status: 400 }
      );
    }
    console.error('Error updating member:', error);
    return NextResponse.json(
      { error: 'Failed to update member' },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/worlds/[id]/members/[memberId] - Remove member
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: worldId, memberId } = await params;

    // Check permissions
    const canManage = await canManageWorldMembers(worldId, sessionUser.id);
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check if member exists
    const member = await prisma.worldMember.findUnique({
      where: { id: memberId },
      include: {
        world: {
          include: {
            universe: {
              select: { ownerId: true },
            },
          },
        },
      },
    });

    if (!member) {
      return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    }

    // Check if member belongs to this world
    if (member.worldId !== worldId) {
      return NextResponse.json({ error: 'Member does not belong to this world' }, { status: 400 });
    }

    // Prevent removing universe owner
    if (member.world.universe.ownerId === member.userId) {
      return NextResponse.json(
        { error: 'Cannot remove universe owner from world' },
        { status: 403 }
      );
    }

    // Cancel any pending invitations for this user to this world
    await prisma.membershipInvitation.updateMany({
      where: {
        worldId: worldId,
        invitedUserId: member.userId,
        status: 'pending',
      },
      data: {
        status: 'cancelled',
        respondedAt: new Date(),
      },
    });

    // Remove member
    await prisma.worldMember.delete({
      where: { id: memberId },
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('Error removing member:', error);
    return NextResponse.json(
      { error: 'Failed to remove member' },
      { status: 500 }
    );
  }
}

