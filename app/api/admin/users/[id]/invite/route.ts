import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { z } from 'zod';
import { getSessionUser } from '@/lib/auth-session';

const inviteToWorldSchema = z.object({
  worldId: z.string().uuid(),
  tags: z.array(z.string()).min(1),
  message: z.string().optional(),
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

// POST /api/admin/users/[id]/invite - Invite user to world (from user profile page)
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const sessionUser = await getSessionUser(request);
    if (!sessionUser) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id: invitedUserId } = await params;
    const body = await request.json();
    const data = inviteToWorldSchema.parse(body);

    // Check if invited user exists
    const invitedUser = await prisma.user.findUnique({
      where: { id: invitedUserId },
    });

    if (!invitedUser) {
      return NextResponse.json({ error: 'User not found' }, { status: 404 });
    }

    // Check permissions for the world
    const canManage = await canManageWorldMembers(data.worldId, sessionUser.id);
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check if world exists
    const world = await prisma.world.findUnique({
      where: { id: data.worldId },
    });

    if (!world) {
      return NextResponse.json({ error: 'World not found' }, { status: 404 });
    }

    // Check if user is already a member
    const existingMember = await prisma.worldMember.findUnique({
      where: {
        userId_worldId: {
          userId: invitedUserId,
          worldId: data.worldId,
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
    const existingInvitation = await prisma.membershipInvitation.findFirst({
      where: {
        worldId: data.worldId,
        invitedUserId: invitedUserId,
        status: 'pending',
      },
    });

    if (existingInvitation) {
      return NextResponse.json(
        { error: 'User already has a pending invitation' },
        { status: 400 }
      );
    }

    // Create invitation
    const invitation = await prisma.membershipInvitation.create({
      data: {
        worldId: data.worldId,
        invitedUserId: invitedUserId,
        invitedByUserId: sessionUser.id,
        status: 'pending',
        tags: data.tags,
        message: data.message || null,
      },
      include: {
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
        invitedBy: {
          select: {
            id: true,
            name: true,
            email: true,
          },
        },
      },
    });

    return NextResponse.json({ invitation }, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: 'Invalid request data', details: error.errors },
        { status: 400 }
      );
    }
    console.error('Error inviting user:', error);
    return NextResponse.json(
      { error: 'Failed to invite user' },
      { status: 500 }
    );
  }
}

