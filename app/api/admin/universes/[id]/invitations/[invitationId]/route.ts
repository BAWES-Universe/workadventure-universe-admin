import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { allows, type Reach } from '@/lib/role-access';
import { badRequest, failed, needs, universeContext } from '@/lib/universe-route';

// DELETE /api/admin/universes/[id]/invitations/[invitationId] - Take back an invitation that has not been answered
export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string; invitationId: string }> }) {
  try {
    const { id, invitationId } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access } = context;

    const invitation = await prisma.membershipInvitation.findFirst({
      where: { id: invitationId, OR: [{ universeId: id }, { world: { universeId: id } }] },
      select: { id: true, status: true, universeId: true, allWorlds: true, worldIds: true, worldId: true },
    });
    if (!invitation) return NextResponse.json({ error: 'Invitation not found' }, { status: 404 });
    if (invitation.status !== 'pending') return badRequest('This invitation has been answered');

    // Where it would have made them a member: the worlds it names, or the one world of an older invitation
    const reach: Reach = !invitation.universeId
      ? { allWorlds: false, worldIds: [invitation.worldId] }
      : invitation.allWorlds
        ? { allWorlds: true }
        : { allWorlds: false, worldIds: invitation.worldIds };
    if (!allows(access, 'INVITE_AND_REMOVE', reach)) return needs('Invite and remove people in every world it names');

    await prisma.membershipInvitation.update({ where: { id: invitation.id }, data: { status: 'cancelled', respondedAt: new Date() } });
    return NextResponse.json({ success: true });
  } catch (error) {
    return failed(error, 'cancel invitation');
  }
}
