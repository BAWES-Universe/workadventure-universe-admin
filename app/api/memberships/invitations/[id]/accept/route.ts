import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';

// POST /api/memberships/invitations/[id]/accept - Accept invitation
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

    // Find invitation
    const invitation = await prisma.membershipInvitation.findUnique({
      where: { id },
      include: {
        world: true,
      },
    });

    if (!invitation) {
      return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    }

    // Check if invitation belongs to current user
    if (invitation.invitedUserId !== sessionUser.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check if invitation is still pending
    if (invitation.status !== 'pending') {
      return NextResponse.json(
        { error: 'Invitation is no longer pending' },
        { status: 400 }
      );
    }

    // Check if user is already a member
    const existingMember = await prisma.worldMember.findUnique({
      where: {
        userId_worldId: {
          userId: sessionUser.id,
          worldId: invitation.worldId,
        },
      },
    });

    if (existingMember) {
      // Update invitation status to accepted even though member already exists
      await prisma.membershipInvitation.update({
        where: { id },
        data: {
          status: 'accepted',
          respondedAt: new Date(),
        },
      });
      return NextResponse.json({ 
        message: 'Already a member',
        member: existingMember 
      });
    }

    // Use transaction to create member and update invitation
    const result = await prisma.$transaction(async (tx) => {
      // Create world member with tags from invitation
      const member = await tx.worldMember.create({
        data: {
          userId: sessionUser.id,
          worldId: invitation.worldId,
          tags: invitation.tags, // Use tags from invitation
        },
      });

      // Update invitation
      await tx.membershipInvitation.update({
        where: { id },
        data: {
          status: 'accepted',
          respondedAt: new Date(),
        },
      });

      return member;
    });

    return NextResponse.json({ member: result });
  } catch (error) {
    console.error('Error accepting invitation:', error);
    return NextResponse.json(
      { error: 'Failed to accept invitation' },
      { status: 500 }
    );
  }
}

