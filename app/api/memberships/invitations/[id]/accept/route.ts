import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { joinUniverse, roleIdsForTags } from '@/lib/universe-members';

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

    // Join the universe with the invitation's roles and worlds. Someone already in it keeps everything they have and
    // gets these on top. An invitation sent before roles names one world and its tags.
    const universeId = invitation.universeId ?? invitation.world.universeId;
    const result = await prisma.$transaction(async (tx) => {
      const roleIds = invitation.universeId
        ? invitation.roleIds
        : await roleIdsForTags(tx, universeId, invitation.tags);
      const worlds = invitation.universeId
        ? { allWorlds: invitation.allWorlds, worldIds: invitation.worldIds }
        : { allWorlds: false, worldIds: [invitation.worldId] };
      await joinUniverse(tx, {
        universeId,
        userId: sessionUser.id,
        worlds,
        roles: roleIds.map((roleId) => ({ roleId, scope: worlds })),
      });

      await tx.membershipInvitation.update({
        where: { id },
        data: {
          status: 'accepted',
          respondedAt: new Date(),
        },
      });

      return tx.worldMember.findUnique({
        where: { userId_worldId: { userId: sessionUser.id, worldId: invitation.worldId } },
      });
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

