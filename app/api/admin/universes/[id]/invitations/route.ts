import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { prisma } from '@/lib/db';
import { EVERYONE_KEY, MEMBER_KEY, coversWorld } from '@/lib/roles';
import { allows, invitationReach, isAdministratorRole, ranksAbove, reachOf, worldsAllowing } from '@/lib/role-access';
import { SYSTEM_USER_EMAIL } from '@/lib/system-user';
import { withWokas } from '@/lib/woka-avatar';
import { badRequest, checkScope, failed, needs, scopeSchema, universeContext } from '@/lib/universe-route';

const inviteSchema = z.object({
  userId: z.string().uuid(),
  /** Roles on top of Member, which everyone who joins has. */
  roleIds: z.array(z.string().uuid()).max(50).default([]),
  worlds: scopeSchema,
  message: z.string().trim().max(500).optional(),
});

// POST /api/admin/universes/[id]/invitations - Invite someone to the universe: some worlds or all, with roles
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access, universe, user } = context;

    const data = inviteSchema.parse(await request.json());
    const { worlds } = data;
    const invalid = checkScope(worlds, access.worldIds);
    if (invalid) return badRequest(invalid);
    if (access.worldIds.length === 0) return badRequest('This universe has no worlds yet');
    if (!allows(access, 'INVITE_AND_REMOVE', reachOf(worlds))) return needs('Invite and remove people in every world picked');

    const roleIds = [...new Set(data.roleIds)];
    const roles = await prisma.role.findMany({ where: { universeId: id, id: { in: roleIds } } });
    if (roles.length !== roleIds.length) return badRequest('A role is not in this universe');
    for (const role of roles) {
      if (role.key === MEMBER_KEY || role.key === EVERYONE_KEY) return badRequest('Everyone who joins is a Member');
      if (!ranksAbove(access, role)) return needs(`a role above ${role.name}`);
      if (isAdministratorRole(role) && !worlds.allWorlds) return badRequest('Administrator works in every world');
    }
    if (roles.length > 0 && !allows(access, 'GIVE_ROLES', reachOf(worlds))) return needs('Give roles in every world picked');

    const invitee = await prisma.user.findUnique({ where: { id: data.userId }, select: { id: true, email: true } });
    if (!invitee || invitee.email === SYSTEM_USER_EMAIL) return NextResponse.json({ error: 'User not found' }, { status: 404 });
    if (invitee.id === universe.ownerId) return badRequest('The owner already has everything');

    const member = await prisma.universeMember.findUnique({
      where: { universeId_userId: { universeId: id, userId: invitee.id } },
      select: { allWorlds: true, worldIds: true },
    });
    const covered = member && (member.allWorlds || (!worlds.allWorlds && worlds.worldIds.every((worldId) => coversWorld(member, worldId))));
    if (covered) return badRequest('They are already a member there. Give roles on their page.');

    const pending = await prisma.membershipInvitation.findFirst({
      where: { invitedUserId: invitee.id, status: 'pending', OR: [{ universeId: id }, { world: { universeId: id } }] },
      select: { id: true },
    });
    if (pending) return badRequest('They already have an invitation to this universe');

    // world_id stays the first world picked, for the screens that show one world
    const worldId = worlds.allWorlds ? access.worldIds[0] : worlds.worldIds[0];
    const fields = {
      invitedByUserId: user.id,
      status: 'pending',
      tags: [],
      universeId: id,
      roleIds,
      allWorlds: worlds.allWorlds,
      worldIds: worlds.worldIds,
      message: data.message || null,
      invitedAt: new Date(),
      respondedAt: null,
    };
    // A cancelled or turned-down invitation to the same world is sent again, as the world invite does
    const earlier = await prisma.membershipInvitation.findFirst({
      where: { worldId, invitedUserId: invitee.id, status: { in: ['cancelled', 'rejected'] } },
      orderBy: { invitedAt: 'desc' },
      select: { id: true },
    });
    const invitation = earlier
      ? await prisma.membershipInvitation.update({ where: { id: earlier.id }, data: fields })
      : await prisma.membershipInvitation.create({ data: { ...fields, worldId, invitedUserId: invitee.id } });

    return NextResponse.json(
      {
        invitation: {
          id: invitation.id,
          userId: invitee.id,
          roleIds,
          worlds,
          status: invitation.status,
          invitedAt: invitation.invitedAt,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
      return badRequest('They already have an invitation to this universe');
    }
    return failed(error, 'invite');
  }
}

/** The most invitations listed at once, newest first. */
const LISTED = 200;

// GET /api/admin/universes/[id]/invitations - Invitations still waiting for an answer, newest first. Each person sees the
// invitations they could send or take back: ones that name only worlds where they may invite and remove people (an
// every-world invitation needs that permission everywhere). For everyone else the list is empty.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access } = context;

    const where = worldsAllowing(access, 'INVITE_AND_REMOVE');
    if (where !== 'all' && where.length === 0) return NextResponse.json({ invitations: [], canCancel: false });

    // Someone who may invite only in some worlds gets just the invitations that start in one of them (an invitation's
    // world is always one it gives, and never a deleted one), and the newest 200 are counted after the rule below, so
    // older ones of theirs are never pushed out by invitations elsewhere
    const rows = await prisma.membershipInvitation.findMany({
      where: {
        status: 'pending',
        OR: [{ universeId: id }, { world: { universeId: id } }],
        ...(where === 'all' ? {} : { allWorlds: false, worldId: { in: where } }),
      },
      include: {
        invitedUser: { select: { id: true, name: true, email: true } },
        invitedBy: { select: { id: true, name: true } },
      },
      orderBy: { invitedAt: 'desc' },
      ...(where === 'all' ? { take: LISTED } : {}),
    });
    // The rule that cancelling uses, so everything listed can be taken back
    const mine = rows.filter((row) => allows(access, 'INVITE_AND_REMOVE', invitationReach(row))).slice(0, LISTED);
    const invitations = mine.map((row) => ({
      id: row.id,
      userId: row.invitedUser.id,
      name: row.invitedUser.name,
      email: row.invitedUser.email,
      invitedBy: { userId: row.invitedBy.id, name: row.invitedBy.name },
      invitedAt: row.invitedAt,
      roleIds: row.roleIds,
      // An invitation from before roles names one world and a tag: they join as a Member there
      worlds: row.universeId ? { allWorlds: row.allWorlds, worldIds: row.worldIds } : { allWorlds: false, worldIds: [row.worldId] },
      tags: row.tags,
    }));
    return NextResponse.json({ invitations: await withWokas(invitations), canCancel: invitations.length > 0 });
  } catch (error) {
    return failed(error, 'list invitations');
  }
}
