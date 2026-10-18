import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { EVERYONE_KEY, MEMBER_KEY, syncWorldMembers } from '@/lib/roles';
import { allows, isAdministratorRole, ranksAbove, reachOf, scopeChange, type Access } from '@/lib/role-access';
import { badRequest, checkScope, failed, needs, scopeSchema, universeContext } from '@/lib/universe-route';

type Params = { params: Promise<{ id: string; userId: string; roleId: string }> };

async function load(universeId: string, userId: string, roleId: string, ownerId: string) {
  const [role, member] = await Promise.all([
    prisma.role.findFirst({ where: { id: roleId, universeId } }),
    prisma.universeMember.findUnique({
      where: { universeId_userId: { universeId, userId } },
      include: { roles: { include: { role: { select: { position: true } } } } },
    }),
  ]);
  const given = member?.roles.find((row) => row.roleId === roleId) ?? null;
  // The owner is above every role, so only they (or a super admin) change their roles
  const theirHighest = userId === ownerId ? Infinity : Math.max(1, ...(member?.roles ?? []).map((row) => row.role.position));
  return { role, member, given, theirHighest };
}

/** Like Discord: someone else's roles are changed only from above them. Your own roles below yours are yours to change. */
function outranks(access: Access, userId: string, viewerId: string, theirHighest: number) {
  return access.full || userId === viewerId || theirHighest < access.highest;
}

// PUT /api/admin/universes/[id]/members/[userId]/roles/[roleId] - Give someone a role, or change where it works
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const { id, userId, roleId } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access, universe, user } = context;

    const { role, member, given, theirHighest } = await load(id, userId, roleId, universe.ownerId);
    if (!role) return NextResponse.json({ error: 'Role not found' }, { status: 404 });
    if (!member) return NextResponse.json({ error: 'Member not found' }, { status: 404 });
    if (role.key === MEMBER_KEY || role.key === EVERYONE_KEY) return badRequest('Everyone who joined has this role');
    if (!ranksAbove(access, role)) return needs('a role above this one');
    if (!outranks(access, userId, user.id, theirHighest)) return needs('a role above theirs');

    const scope = scopeSchema.parse(await request.json());
    const invalid = checkScope(scope, access.worldIds);
    if (invalid) return badRequest(invalid);
    // A role works only where they are a member: adding a world is an invitation, which they accept
    if (!member.allWorlds && (scope.allWorlds || scope.worldIds.some((worldId) => !member.worldIds.includes(worldId)))) {
      return badRequest('They are not a member of every world picked');
    }
    if (isAdministratorRole(role) && !scope.allWorlds) return badRequest('Administrator works in every world');
    if (!allows(access, 'GIVE_ROLES', scopeChange(given, scope))) return needs('Give roles in every world this changes');

    await prisma.$transaction(async (tx) => {
      await tx.universeMemberRole.upsert({
        where: { memberId_roleId: { memberId: member.id, roleId } },
        create: { memberId: member.id, roleId, ...scope },
        update: scope,
      });
      await syncWorldMembers(tx, id, userId);
    });
    return NextResponse.json({ given: { roleId, ...scope } });
  } catch (error) {
    return failed(error, 'give role');
  }
}

// DELETE /api/admin/universes/[id]/members/[userId]/roles/[roleId] - Take a role away
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const { id, userId, roleId } = await params;
    const context = await universeContext(request, id);
    if (!context.ok) return context.response;
    const { access, universe, user } = context;

    const { role, member, given, theirHighest } = await load(id, userId, roleId, universe.ownerId);
    if (!role || !member || !given) return NextResponse.json({ error: 'They do not have this role' }, { status: 404 });
    if (!ranksAbove(access, role)) return needs('a role above this one');
    if (!outranks(access, userId, user.id, theirHighest)) return needs('a role above theirs');
    if (!allows(access, 'GIVE_ROLES', reachOf(given))) return needs('Give roles in every world this role works in');

    await prisma.$transaction(async (tx) => {
      await tx.universeMemberRole.delete({ where: { id: given.id } });
      // Someone left in no world at all is no longer in the universe
      const left = await tx.universeMemberRole.count({ where: { memberId: member.id } });
      if (left === 0 && !member.allWorlds && member.worldIds.length === 0) {
        await tx.universeMember.delete({ where: { id: member.id } });
      }
      await syncWorldMembers(tx, id, userId);
    });
    return NextResponse.json({ success: true });
  } catch (error) {
    return failed(error, 'take role away');
  }
}
