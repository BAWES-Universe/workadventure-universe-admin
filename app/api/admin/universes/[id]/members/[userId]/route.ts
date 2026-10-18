import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { withWokas } from '@/lib/woka-avatar';
import { allows, ranksAbove, worldsAllowing, type Reach } from '@/lib/role-access';
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

/** Every world someone is in: through their membership or any role. */
function reachOfMember(member: { allWorlds: boolean; worldIds: string[]; roles: { allWorlds: boolean; worldIds: string[] }[] }): Reach {
  if (member.allWorlds || member.roles.some((given) => given.allWorlds)) return { allWorlds: true };
  return { allWorlds: false, worldIds: [...new Set([...member.worldIds, ...member.roles.flatMap((given) => given.worldIds)])] };
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

    // The owner is above every role
    const theirHighest = isOwner ? Infinity : Math.max(1, ...joined.roles.map((given) => given.role.position));
    // Member and Everyone come with joining, so they are never given or taken
    const roles = await prisma.role.findMany({
      where: { universeId: id, key: { notIn: ['member', 'everyone'] } },
      select: { id: true, position: true },
    });
    const givable = worldsAllowing(access, 'GIVE_ROLES');
    // Someone else's roles are changed only from above them
    // The owner has every permission already: nothing to give
    const canGiveAnywhere = !isOwner && (givable === 'all' || givable.length > 0) && (access.full || userId === user.id || theirHighest < access.highest);

    const [[withWoka], lastVisitedAt] = await Promise.all([
      withWokas([memberForJson(joined, universe.ownerId, managesPeople(access) || userId === user.id, seesHiddenRoles(access) || userId === user.id)]),
      lastVisitIn(id, userId),
    ]);
    return NextResponse.json({
      // When they last came into any room of this universe, from the room visits
      member: { ...withWoka, lastVisitedAt },
      can: {
        // The roles you may give or take away (below your own), and the worlds where you may
        giveRoleIds: canGiveAnywhere
          ? roles.filter((role) => ranksAbove(access, role)).map((role) => role.id)
          : [],
        giveWorlds: givable,
        // Taking someone out: never the owner, only below you, and only where you may remove people. Leaving is yours.
        remove:
          userId === user.id
            ? !isOwner
            : !isOwner &&
              (access.full || theirHighest < access.highest) &&
              allows(access, 'INVITE_AND_REMOVE', reachOfMember(joined)),
      },
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
