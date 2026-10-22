import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withWokas } from '@/lib/woka-avatar';
import { allows } from '@/lib/role-access';
import { memberCan, reachOfMember } from '@/lib/member-can';
import { leaveUniverse } from '@/lib/universe-members';
import { failed, managesPeople, memberForJson, memberInclude, needs, seesHiddenRoles, universeContext } from '@/lib/universe-route';

type Params = { params: Promise<{ id: string; userId: string }> };

async function findMember(universeId: string, userId: string) {
  return prisma.universeMember.findUnique({
    where: { universeId_userId: { universeId, userId } },
    include: memberInclude,
  });
}

/** When someone last entered any room of the universe, or null when they never did. */
async function lastVisitIn(universeId: string, userId: string): Promise<Date | null> {
  const visit = await prisma.roomAccess.aggregate({ where: { universeId, userId }, _max: { accessedAt: true } });
  return visit._max.accessedAt ?? null;
}

/** The owner who never joined: a member in every world with no roles, shaped like a member row. */
async function ownerWithoutMembership(universeId: string, userId: string) {
  const [user, universe] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } }),
    prisma.universe.findUnique({ where: { id: universeId }, select: { createdAt: true } }),
  ]);
  if (!user) return null;
  return {
    id: userId,
    universeId,
    userId,
    allWorlds: true,
    worldIds: [] as string[],
    joinedAt: universe?.createdAt ?? new Date(),
    user,
    roles: [] as { roleId: string; allWorlds: boolean; worldIds: string[]; role: { position: number; showBadge: boolean } }[],
  };
}

// GET /api/admin/universes/[id]/members/[userId] - One member, and what you may change about them
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const { id, userId } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access, universe, user } = context;

    const isOwner = userId === universe.ownerId;
    const member = await findMember(id, userId);
    // The owner has everything whether or not they joined, so their page opens either way
    if (!member && !isOwner) return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    const joined = member ?? (await ownerWithoutMembership(id, userId));
    if (!joined) return NextResponse.json({ error: 'Member not found' }, { status: 404 });

    // Member and Everyone come with joining, so they are never given or taken
    const roles = await prisma.role.findMany({
      where: { universeId: id, key: { notIn: ['member', 'everyone'] } },
      select: { id: true, position: true },
    });
    const can = memberCan({ access, viewerId: user.id, userId, ownerId: universe.ownerId, member: joined, roles });

    // Who came when is visitor detail: only for people who manage members, and for yourself
    const seesVisits = managesPeople(access) || userId === user.id;
    const [[withWoka], lastVisitedAt] = await Promise.all([
      withWokas([memberForJson(joined, universe.ownerId, managesPeople(access) || userId === user.id, seesHiddenRoles(access) || userId === user.id)]),
      seesVisits ? lastVisitIn(id, userId) : Promise.resolve(undefined),
    ]);
    return NextResponse.json({
      // When they last came into any room of this universe, from the room visits; left out when you may not see it
      member: seesVisits ? { ...withWoka, lastVisitedAt } : withWoka,
      can,
    });
  } catch (error) {
    return failed(error, 'read member');
  }
}

// DELETE /api/admin/universes/[id]/members/[userId] - Take someone out of the universe, or leave it yourself
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id, userId } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access, universe, user } = context;

    const member = await findMember(id, userId);
    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    if (userId === universe.ownerId) return NextResponse.json({ error: 'The owner cannot be removed' }, { status: 400 });

    if (userId !== user.id) {
      const theirHighest = Math.max(1, ...member.roles.map((given) => given.role.position));
      if (!access.full && theirHighest >= access.highest) return needs('a role above theirs');
      if (!allows(access, 'INVITE_AND_REMOVE', reachOfMember(member))) {
        return needs('Invite and remove people in every world they are in');
      }
    }

    await prisma.$transaction((tx) => leaveUniverse(tx, id, userId), { timeout: 30_000 });
    return NextResponse.json({ success: true });
  } catch (error) {
    return failed(error, 'remove member');
  }
}
